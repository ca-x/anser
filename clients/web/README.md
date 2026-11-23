# Anser Web 管理台

使用 React、Elastic UI 和 Vite。服务端通过同源 API 提供用户登录和管理操作。临时登录令牌保留在当前浏览器标签页会话，渠道凭据和用户密码只用于提交表单。

登录页和管理台均可切换简体中文与 English，并选择跟随系统、浅色或深色。界面偏好保存在当前浏览器。

需要 Node.js 22.12 或更新版本。

```sh
npm ci
npm test
npm run build
```

在装有 Chrome 的机器上，运行 `CHROME_BIN="$(command -v google-chrome)" npm run test:browser` 验证生产构建的桌面、缩放及手机路由表单。

生成的 `dist/index.html` 用于 Anser 的 `/login` 和 `/admin/*`。Vite 资源前缀为 `/assets/anser/`，相对路径必须与 `dist/` 中的目录一致。

开发时运行 `npm run dev`。默认代理到 `http://127.0.0.1:8080`，可用 `ANSER_DEV_API` 指向另一台 Anser 服务器。

Elastic UI 依赖的授权与声明随构建一同提供，见 [Elastic UI 许可](public/licenses/EUI-LICENSE.txt)、[Elastic License 2.0](public/licenses/ELASTIC-LICENSE-2.0.md)和[声明](public/licenses/EUI-NOTICE.txt)。
