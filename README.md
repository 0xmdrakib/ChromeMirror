# Chrome Mirror

Chrome Mirror is a self-hosted, secure, and compiled remote browser mirroring application that replicates user actions (clicks, keyboard inputs, scrolls, and navigations) in real-time between a Leader and a Follower Chrome browser profile.

---

## Overview

Chrome Mirror is built for two things:

- **1:1 Mirroring:** Map any Leader browser tab directly to a Follower browser tab. Every action is copied with Playwright's trusted input replayer.
- **Licensing & Security:** Securely gate the application using BIOS UUID hardware fingerprinting, remote license validation, heartbeats, and V8 bytecode packaging.

The app focuses on providing a clean control panel for launching paired Chrome sessions, while enforcing strong anti-cloning and licensing protections via a remote Supabase database.

## Features

- Real-time action mirroring (mouse clicks, keyboard typing, page scrolling, and address-bar navigations)
- Multi-tab synchronization (automatic opening, pairing, and closing of follower tabs)
- Hardware fingerprinting (keys are bound to a single physical machine using BIOS UUID, OS Volume Serial, and Windows Machine GUID)
- Background heartbeat monitoring (locks the client application instantly if a license key is deleted or revoked from the administrator console)
- V8 Bytecode Protection (`bytenode`) to compile main process scripts and licensing logic into machine-like binary `.jsc` files
- Javascript Obfuscator defenses for renderer UI and preload scripts to prevent reverse-engineering and source inspection
- Web-based Admin Control Console to generate licenses, manage active devices, monitor live statuses, and delete licenses
- Portable Windows setup packaged as a standard desktop installer using `electron-builder` with custom branding

## License & Security States

### License States

| State | Description | Client Behavior |
|---|---|---|
| `unused` | Newly generated key, not yet activated | Prompts user on launch to enter license key |
| `active` | Key bound to a verified hardware signature | Grants full access to mirroring control panel |
| `suspended` | Temporarily disabled by the administrator | Locks the client app on next heartbeat check |
| `cancelled` | Permanently revoked | Wipes local license tokens, prompts for activation |
| `deleted` | Completely removed from database | Wipes local storage, locks out online client instantly |

### Admin Console Actions

- **Generate License**: Creates a unique license key in the standard `CMIR-XXXX-XXXX-XXXX-XXXX` format with customizable expiration and labels.
- **Delete License**: Deletes the license row from the database. Due to database cascades, this instantly clears active device bindings and heartbeat logs, triggering a lockout on the client's next heartbeat ping.

## Tech stack

- **Desktop App:** Electron 42, HTML5 / Vanilla CSS, Javascript
- **Automation Engine:** Playwright 1.60 (runs in-process, CDP pipe automation)
- **Backend Database:** Supabase (PostgreSQL tables, database views, row-level security, RPCs)
- **Code Protection:** Bytenode (V8 bytecode compiler), Javascript Obfuscator
- **Package Builder:** Electron Builder (compiled Windows NSIS installer)

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root. Copy from [.env.example](./.env.example):

```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
```

### 3. Run the development server

```bash
npm start
```

### 4. Build for production

Run the prebuild script to obfuscate assets and compile main files into V8 bytecode:

```bash
npm run prebuild
```

### 5. Compile desktop installer package (Optional)

Compile the final Windows installer executable:

```bash
npm run dist
```

The installer setup executable will be generated at:
```text
dist/Chrome Mirror Setup 1.0.0.exe
```

### 6. Download packaged installer

The pre-compiled, secure, and ready-to-run Windows installer `.exe` is available directly on the GitHub Releases page:
- **Download the latest version**: [Chrome Mirror Releases](https://github.com/0xmdrakib/ChromeMirror/releases)

---

## Usage

### Database & Auth Setup

1. Open your Supabase Dashboard and paste the definitions in `supabase/schema.sql` into the SQL Editor, then click **Run**.
2. Go to **Authentication** -> **Users** and create your administrator user.
3. In the SQL Editor, insert your administrator's User UID into the `public.admin_users` table to grant them dashboard permissions:
   ```sql
   INSERT INTO public.admin_users (user_id) VALUES ('your_admin_user_uid');
   ```

### Manage Licenses

1. Open the Admin Console (`admin/index.html`) in your browser and sign in.
2. Click **Generate License**, fill in details, and click **Generate**.
3. Copy the key and paste it into the client application to activate the device.

---

## Data storage

By default, the client stores its active session token and verified license data locally inside the Electron AppData folder:

```text
%APPDATA%\chrome-mirror\
```

The admin console connects directly to the Supabase PostgreSQL database. Device bindings and heartbeat logs are automatically managed via cascading deletes when a license is removed.

---

## Safety

Use this for legitimate remote browser sharing and automation coordination. Do not use it to bypass website terms of service, scraping restrictions, or automated login policies.

## License

This project is licensed under the [MIT License](./LICENSE).
