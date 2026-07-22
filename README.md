# Chrome Mirror

Chrome Mirror is a Windows desktop application that mirrors actions from one leader Chrome profile to up to 24 follower profiles.

Website: [chromemirror.rakibhq.xyz](https://chromemirror.rakibhq.xyz/)

Download: [Latest GitHub release](https://github.com/0xmdrakib/ChromeMirror/releases/latest)

---

## Features

- One leader and up to 24 follower Chrome profiles
- Fast click, typing, scrolling, navigation, and multi-tab mirroring
- Pause and resume mirroring without closing browser windows or tabs
- Persistent Chrome profiles for saved logins and browser data
- Automatic follower recovery and ordered per-follower event queues
- Tiled, leader-visible, and last-used window layouts
- Secure one-device licence activation with restart persistence
- Built-in customer dashboard and licence management website

## Requirements

- Windows 10 or Windows 11
- Google Chrome
- An active Chrome Mirror licence for the official desktop build

## Download

Download the Windows installer from the [Releases page](https://github.com/0xmdrakib/ChromeMirror/releases). The release also includes a ZIP containing only the installer EXE.

Purchase and manage your licence from the [Chrome Mirror website](https://chromemirror.rakibhq.xyz/).

## Development

Install dependencies and start the desktop app:

```powershell
npm ci
npm start
```

Run the complete verification suite:

```powershell
npm run verify
```

Build the Windows installer:

```powershell
npm run dist
```

The hosted website and licence API are located in [`web/`](web/). Copy the relevant `.env.example` file before local development; never commit real credentials.

## Responsible use

Use Chrome Mirror only with browser profiles and websites you are authorized to control. Follow website terms, automation limits, and applicable law.

## License

The source code is available under the [MIT License](LICENSE).
