# AP C2S + MLS client

Example client for ActivityPub MLS

This requires https://openmls.tech wasm bindings, for now clone https://github.com/bonfire-networks/openmls/tree/wasm-bindings to `/assets/static/assets/openmls` and run:

```
cargo install wasm-pack

cargo build --release --verbose --target wasm32-unknown-unknown -p openmls --features js

cd openmls-wasm && ./build.sh && cp -r pkg  ../../bonfire-app/assets/static/tauri/assets/openmls
```