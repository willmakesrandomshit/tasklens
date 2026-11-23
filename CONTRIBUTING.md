# Contributing

Thank you for helping improve Traceback. Open an issue to discuss substantial changes before implementing them. Small fixes and documentation improvements are welcome.

1. Fork the repository and create a focused branch.
2. Build and test on Windows using the instructions in the README.
3. Add meaningful tests for behavior and safety boundaries, especially process identity and permission failures.
4. Open a pull request describing the change, how it was tested, and any limitations. Do not include secrets or private system information.
5. Address review feedback; maintainers can contribute throughout the codebase.

Never test destructive controls on critical processes or unrelated applications. Use dedicated disposable test processes. Do not submit code that bypasses Windows access controls or uploads telemetry without informed consent. Use original or appropriately licensed material and document third-party attribution.
