# @opencitadel/master

`citadel-master` is the open, self-hostable server list and plugin registry for
[Deadlock](https://store.steampowered.com/app/1422450/Deadlock/) community servers:

* a REST API, with heartbeats from OpenCitadel hosts and Deadworks servers;
* A2S verification of listed servers;
* a web server browser;
* a plugin registry with minisign signatures, advisories and trusted publishing from GitHub
  Actions;
* Deadworks-compatible FastDL.

```sh
npm install -g @opencitadel/master
citadel-master serve --port 8080 --data ./data --public-url https://servers.example.org
citadel-master account create my-community
```

Requires Node.js 22.13 or newer. See the [OpenCitadel repository](https://github.com/thomasreichmann/opencitadel)
for the operator guide (`docs/HOSTING.md`, `docs/REGISTRY.md`). Not affiliated with Valve.
