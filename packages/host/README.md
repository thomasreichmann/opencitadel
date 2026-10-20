# @opencitadel/host

`citadel-host` runs and supervises a [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/)
dedicated server (`deadlock.exe -dedicated` or Deadworks) and lists it on an OpenCitadel master.
It also manages plugins: it installs them from a registry with signature checks and runs host
plugins in a WebAssembly sandbox. `citadel-pkg` installs Deadworks plugins and content packs for
servers that don't run `citadel-host`.

```sh
npm install -g @opencitadel/host
citadel-host init
citadel-host register --api-key ock_… --master https://servers.example.org
citadel-host start
```

Plugin authors publish from CI with trusted publishing:

```sh
npx --yes --package=@opencitadel/host citadel-host plugin publish . --oidc
```

Requires Node.js 22.13 or newer. See the [OpenCitadel repository](https://github.com/thomasreichmann/opencitadel)
for the hosting guide, the plugin guide and the architecture. Not affiliated with Valve.
