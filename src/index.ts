import fs from 'node:fs'
import path from 'node:path'
import { type Plugin, type PluginBuild } from 'esbuild'
import { createHash } from 'node:crypto'
import * as compiler from 'vue/compiler-sfc'
import { type CompilerOptions } from 'vue/compiler-sfc'
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)
const removeQuery = (p: string) => p.replace(/\?.+$/, '')
const normalizePath = (p: string) => p.replace(/\\/g, '/')
const genId = (filepath: string) => hash(normalizePath(path.relative((globalThis as any).process?.cwd() || '', filepath)))


export interface VuePluginOptions {
  sourceMap?: boolean
  isProduction?: boolean
  template?: {
    compilerOptions?: CompilerOptions
  }
  style?: {
    preprocessLang?: string
  }
}

export default (options: VuePluginOptions = {}): Plugin => {
  return {
    name: 'vue',

    setup(build: PluginBuild) {
      const absPath = path.resolve(
        (globalThis as any).process?.cwd() || '',
        build.initialOptions.absWorkingDir || '',
      )
      const useSourceMap = !!build.initialOptions.sourcemap || !!options.sourceMap

      build.initialOptions.define = build.initialOptions.define || {}
      Object.assign(build.initialOptions.define, {
        __VUE_OPTIONS_API__:
          build.initialOptions.define?.__VUE_OPTIONS_API__ ?? true,
        __VUE_PROD_DEVTOOLS__:
          build.initialOptions.define?.__VUE_PROD_DEVTOOLS__ ?? false,
      })

      // 处理 alias 配置，支持 object 和 array 两种形式
      const aliases = (() => {
        const a = build.initialOptions.alias as any
        if (!a) return [] as Array<{ find: string; replacement: string }>
        if (Array.isArray(a)) return a as Array<{ find: string; replacement: string }>
        if (typeof a === 'object') return Object.keys(a).map((k) => ({ find: k, replacement: (a as any)[k] }))
        return [] as Array<{ find: string; replacement: string }>
      })()

      const formatPath = (p: string, resolveDir?: string) => {

        if (p.startsWith('.')) {
          return path.resolve(resolveDir || absPath, p)
        }

        // 先尝试用 alias 替换（只匹配开头的别名）
        for (const { find, replacement } of aliases) {
          if (p === find || p.startsWith(find + '/')) {
            const rest = p.slice(find.length)
            const repl = replacement.endsWith('/') ? replacement.slice(0, -1) : replacement
            const newPath = repl + rest
            // 如果替换后是相对或绝对路径，则解析为绝对路径返回
            if (newPath.startsWith('.') || path.isAbsolute(newPath)) {
              return path.resolve(absPath, newPath)
            }
            // 否则将其作为模块名返回，让 esbuild 继续解析（例如替换为包名）
            return newPath
          }
        }

        if (p.startsWith(absPath + '/')) {
          return p
        }
        return path.join(absPath, p)
      }

      // 将 .vue 以及带 ?vue 查询的导入解析为真实文件路径并交给默认/file 命名空间处理
      const makeResolveToFile = (filter: RegExp) =>
        build.onResolve({ filter }, (args) => {
          const relative = removeQuery(args.path)
          const resolveDir = args.resolveDir
          const filepath = formatPath(relative, resolveDir)
          const query = args.path.slice(relative.length)
          return {
            path: filepath + query,
            namespace: 'file',
            pluginData: { resolveDir },
          }
        })

      makeResolveToFile(/\.vue$/)
      makeResolveToFile(/\?vue&type=template/)
      makeResolveToFile(/\?vue&type=script/)
      makeResolveToFile(/\?vue&type=style/)

      build.onLoad({ filter: /\.vue$/, namespace: 'file' }, async (args) => {
        try {
          const { resolveDir } = args.pluginData
          const filepath = formatPath(args.path, resolveDir)

          if (!fs.existsSync(filepath)) {
            throw new Error(`Vue file not found: ${filepath}`)
          }

          const content = await fs.promises.readFile(filepath, 'utf8')
          const { descriptor, errors } = compiler.parse(content, {
            filename: filepath,
            sourceMap: useSourceMap
          })

          if (errors.length > 0) {
            throw new Error(`Vue SFC parse errors: ${errors.map(e => e.message).join(', ')}`)
          }

          let contents = ``

          const inlineTemplate =
            !!descriptor.scriptSetup && !descriptor.template?.src
          const isTS =
            descriptor.scriptSetup?.lang === 'ts' ||
            descriptor.script?.lang === 'ts'
          const hasScoped = descriptor.styles.some((s) => s.scoped)

          if (descriptor.script || descriptor.scriptSetup) {
            const scriptResult = compiler.compileScript(descriptor, {
              id: genId(args.path),
              inlineTemplate,
              sourceMap: useSourceMap,
            })
            contents += compiler.rewriteDefault(
              scriptResult.content,
              '__sfc_main',
              isTS ? ['typescript'] : undefined,
            )
          } else {
            contents += `let __sfc_main = {}`
          }

          if (descriptor.styles.length > 0) {
            contents += `\nimport \"${normalizePath(args.path)}?vue&type=style\"\n`
          }

          if (descriptor.template && !inlineTemplate) {
            contents += `\nimport { render } from \"${normalizePath(args.path)}?vue&type=template\"\n\n__sfc_main.render = render\n`
          }

          if (hasScoped) {
            contents += `__sfc_main.__scopeId = \"data-v-${genId(args.path)}\"\n`
          }

          contents += `\nexport default __sfc_main`
          return {
            contents,
            resolveDir: resolveDir || absPath,
            loader: isTS ? 'ts' : 'js',
            watchFiles: [filepath],
          }
        } catch (error) {
          return {
            errors: [{
              text: error instanceof Error ? error.message : String(error),
              location: null,
            }],
          }
        }
      })

      build.onLoad(
        { filter: /\?vue&type=template/, namespace: 'file' },
        async (args) => {
          try {
            const { resolveDir } = args.pluginData
            const relativePath = removeQuery(args.path)
            const filepath = formatPath(relativePath, resolveDir)
            const source = await fs.promises.readFile(filepath, 'utf8')
            const { descriptor, errors } = compiler.parse(source, { filename: filepath })

            if (errors.length > 0) {
              throw new Error(`Vue SFC parse errors: ${errors.map(e => e.message).join(', ')}`)
            }

            if (descriptor.template) {
              const hasScoped = descriptor.styles.some((s) => s.scoped)
              const id = genId(relativePath)
              // if using TS, support TS syntax in template expressions
              const expressionPlugins: CompilerOptions['expressionPlugins'] = []
              const lang = descriptor.scriptSetup?.lang || descriptor.script?.lang
              if (
                lang &&
                /tsx?$/.test(lang) &&
                !expressionPlugins.includes('typescript')
              ) {
                expressionPlugins.push('typescript')
              }

              const compiled = compiler.compileTemplate({
                source: descriptor.template.content,
                filename: filepath,
                id,
                scoped: hasScoped,
                isProd: options.isProduction ?? (globalThis as any).process?.env?.NODE_ENV === 'production',
                slotted: descriptor.slotted,
                preprocessLang: descriptor.template.lang,
                compilerOptions: {
                  scopeId: hasScoped ? `data-v-${id}` : undefined,
                  sourceMap: useSourceMap,
                  expressionPlugins,
                  ...options.template?.compilerOptions,
                },
              })

              if (compiled.errors && compiled.errors.length > 0) {
                throw new Error(`Template compilation errors: ${compiled.errors.map(e => typeof e === 'string' ? e : e.message).join(', ')}`)
              }

              return {
                resolveDir: resolveDir || absPath,
                contents: compiled.code,
                watchFiles: [filepath],
              }
            }
          } catch (error) {
            return {
              errors: [{
                text: error instanceof Error ? error.message : String(error),
                location: null,
              }],
            }
          }
        },
      )

      build.onLoad(
        { filter: /\?vue&type=script/, namespace: 'file' },
        async (args) => {
          try {
            const { resolveDir } = args.pluginData
            const relativePath = removeQuery(args.path)
            const filepath = formatPath(relativePath, resolveDir)
            const source = await fs.promises.readFile(filepath, 'utf8')

            const { descriptor, errors } = compiler.parse(source, { filename: filepath })

            if (errors.length > 0) {
              throw new Error(`Vue SFC parse errors: ${errors.map(e => e.message).join(', ')}`)
            }

            if (descriptor.script) {
              const compiled = compiler.compileScript(descriptor, {
                id: genId(relativePath),
                sourceMap: useSourceMap,
              })
              return {
                resolveDir: resolveDir || absPath,
                contents: compiled.content,
                loader: compiled.lang === 'ts' ? 'ts' : 'js',
                watchFiles: [filepath],
              }
            }
          } catch (error) {
            return {
              errors: [{
                text: error instanceof Error ? error.message : String(error),
                location: null,
              }],
            }
          }
        },
      )

      build.onLoad(
        { filter: /\?vue&type=style/, namespace: 'file' },
        async (args) => {
          try {
            const { resolveDir } = args.pluginData
            const relativePath = removeQuery(args.path)
            const filepath = formatPath(relativePath, resolveDir)
            const source = await fs.promises.readFile(filepath, 'utf8')
            const { descriptor, errors } = compiler.parse(source, { filename: filepath })

            if (errors.length > 0) {
              throw new Error(`Vue SFC parse errors: ${errors.map(e => e.message).join(', ')}`)
            }

            if (descriptor.styles.length > 0) {
              const id = genId(relativePath)
              let content = ''
              for (const style of descriptor.styles) {
                const compiled = await compiler.compileStyleAsync({
                  source: style.content,
                  filename: filepath,
                  id,
                  scoped: style.scoped,
                  preprocessLang: style.lang as any,
                  modules: !!style.module,
                })

                if (compiled.errors && compiled.errors.length > 0) {
                  throw new Error(`Style compilation errors: ${compiled.errors.map(e => e.message || String(e)).join(', ')}`)
                }

                content += compiled.code
              }
              return {
                resolveDir: resolveDir || absPath,
                contents: content,
                loader: 'css',
                watchFiles: [filepath],
              }
            }

            // Return empty CSS if no styles
            return {
              resolveDir: resolveDir || absPath,
              contents: '',
              loader: 'css',
              watchFiles: [filepath],
            }
          } catch (error) {
            return {
              errors: [{
                text: error instanceof Error ? error.message : String(error),
                location: null,
              }],
            }
          }
        },
      )

      build.onEnd((result) => {
        // @ts-expect-error from Haya
        const collectCssFile: (file: string) => void = build.collectCssFile
        if (result.metafile && collectCssFile) {
          for (const filename in result.metafile.outputs) {
            if (!filename.endsWith('.css')) continue
            const inputs = Object.keys(result.metafile.outputs[filename].inputs)
            if (inputs.some((name) => name.includes('?vue&type=style'))) {
              collectCssFile(
                path.join(
                  build.initialOptions.absWorkingDir || (globalThis as any).process?.cwd() || '',
                  filename,
                ),
              )
            }
          }
        }
      })
    },
  }
}