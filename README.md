# TaskLens

> Your system. Every process. Total control.

Maintainers: [@willmakesrandomshit](https://github.com/willmakesrandomshit) and [@mynameisjapan26-hue](https://github.com/mynameisjapan26-hue). Development pre-releases are unsigned and not yet suitable as a daily Task Manager replacement.


**Your system. Every process. Total control.**

TaskLens is an open-source Windows system-monitoring application under development, built with Rust, Tauri 2, React and TypeScript. It aims to provide a fast, understandable view of the processes and resources on your PC. This repository is an early development build; it is not yet a complete replacement for Windows Task Manager.

## Project status

TaskLens is in active development. Consult the running application and [CHANGELOG.md](CHANGELOG.md) for currently implemented functionality. Windows services and startup management, persistent resource history, advanced GPU metrics, release packages, accessibility coverage and performance targets require verification before they can be advertised as complete. Unavailable readings should be displayed as unavailable rather than estimated or invented.

There are currently no verified screenshots, release downloads or performance measurements to show here. Release builds should be clearly marked as unsigned unless signing has actually been performed.

## Development

On a Windows development machine, install a supported Rust toolchain, Node.js and npm, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/), including the Microsoft C++ build tools and WebView2. Then:

```powershell
npm install
npm run tauri dev
```

Common checks:

```powershell
npm run typecheck
npm run lint
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

Run these commands on Windows; availability of individual tests and build artifacts depends on the current development state. Neither Windows 10 nor Windows 11 compatibility is claimed verified until tested on each.

## Privacy and safety

Core monitoring is intended to work locally without an account or cloud service. Process actions should be explicit, require confirmation for destructive actions, and respect Windows permissions. Never use the app to bypass security controls. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Architecture and contributing

The React frontend communicates through narrowly defined Tauri commands with a Rust backend that reads system data. Platform access, error handling and action validation belong on the native side. See [the architecture notes](docs/ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

The project is intended as a collaboration between **Wil** and **Elq**. Proposed responsibilities are product, design and community for Wil, and systems, performance and reliability for Elq; both are welcome to contribute across the project. This describes intended collaboration and does not imply acceptance of an invitation or completed contributions.

Licensed under the [MIT License](LICENSE).
