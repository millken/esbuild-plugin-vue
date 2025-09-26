# ESBuild Vue 3 Plugin

一个为 ESBuild 构建的 Vue 3 单文件组件 (SFC) 插件。

## 特性

- 支持 Vue 3 SFC 编译
- 支持 TypeScript 和 JavaScript
- 支持 CSS 预处理器 (Sass, Less, Stylus)
- 支持 Scoped CSS
- 支持 CSS Modules
- 支持源映射 (Source Maps)
- 支持模板中的 TypeScript 表达式
- 完整的错误处理

## 使用方法

```typescript
import { build } from 'esbuild'
import vuePlugin from './esbuild-plugin-vue3'

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  plugins: [
    vuePlugin({
      sourceMap: true,
      isProduction: process.env.NODE_ENV === 'production',
      template: {
        compilerOptions: {
          // Vue 模板编译选项
        }
      },
      style: {
        preprocessLang: 'scss'
      }
    })
  ]
})
```

## 配置选项

- `sourceMap`: 是否生成源映射
- `isProduction`: 是否为生产环境构建
- `template.compilerOptions`: Vue 模板编译器选项
- `style.preprocessLang`: CSS 预处理器语言

## 注意事项

1. 确保已安装 `@vue/compiler-sfc` 作为项目依赖
2. 本插件会自动处理 Vue SFC 的各个部分（template, script, style）
3. 支持 TypeScript 在模板表达式中使用