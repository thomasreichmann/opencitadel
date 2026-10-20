/**
 * `plugin new <dir>`: a ready-to-build starting point for each package kind.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PLUGIN_ID, type PluginKind } from '@opencitadel/protocol';
import { HOST_VERSION } from './version.js';

export interface ScaffoldOptions {
  kind?: PluginKind;
  id?: string;
  name?: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** The CI publish step: citadel-host from npm (pinned to this minor version), trusted publishing. */
export const PUBLISH_COMMAND = `npx --yes --package=@opencitadel/host@${HOST_VERSION.split('.').slice(0, 2).join('.')} citadel-host plugin publish . --oidc`;

/**
 * `.github/workflows/release.yml`: builds, signs and publishes on `v*` tags through trusted
 * publishing, from a protected `release` environment, with no registry key in the repository.
 */
export function releaseWorkflow(id: string, kind: PluginKind): string {
  const build =
    kind === 'host'
      ? ['      - run: npm install', '      - run: npm run build --if-present']
      : kind === 'deadworks'
        ? [
            '      - uses: actions/setup-dotnet@v4',
            '        with:',
            "          dotnet-version: '10.0.x'",
            '      # DeadworksManaged.Api.dll is not on NuGet: make it available to the build (for',
            '      # example vendored under lib/ and passed as -p:DeadlockDir=…) before this step.',
            '      - run: dotnet build -c Release',
          ]
        : ['      # Content packages have nothing to build: the VPKs listed in plugin.json are published as-is.'];
  return [
    '# Publishes this plugin to an OpenCitadel registry when you push a tag like v1.2.3.',
    '#',
    '# It uses trusted publishing: GitHub vouches for this workflow to the registry, which hands',
    '# back a 15-minute publish token, so no registry API key is stored in this repository. The',
    '# package is still signed with your publisher key, and the registry records the commit and',
    '# workflow run that built it.',
    '#',
    '# One-time setup:',
    '#   1. Create and register a signing key (OPENCITADEL_SIGNING_PASSPHRASE set, so it is encrypted):',
    '#        citadel-host plugin keygen',
    '#        citadel-host plugin key register --api-key ock_…',
    '#   2. In this repository, add the secrets OPENCITADEL_SIGNING_KEY (the contents of the .key file)',
    '#      and OPENCITADEL_SIGNING_PASSPHRASE, and the variable OPENCITADEL_MASTER (the registry URL).',
    '#   3. Create a "release" environment (Settings → Environments), ideally with required reviewers.',
    '#   4. Link this workflow to the plugin:',
    `#        citadel-host plugin trusted-publisher add ${id} --repo <owner>/<repo> --workflow release.yml --environment release --api-key ock_…`,
    '#      Add --require to stop account keys from publishing it at all.',
    'name: Release',
    '',
    'on:',
    '  push:',
    "    tags: ['v*']",
    '',
    'jobs:',
    '  publish:',
    '    runs-on: ubuntu-latest',
    '    environment: release',
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '        with:',
    '          persist-credentials: false',
    '      - name: Tag matches plugin.json',
    '        run: |',
    '          want="$(node -p \'require("./plugin.json").version\')"',
    '          [ "${GITHUB_REF_NAME#v}" = "$want" ] || { echo "Tag $GITHUB_REF_NAME does not match plugin.json version $want"; exit 1; }',
    '      - uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 22',
    ...build,
    '      - name: Publish (signed, trusted publishing)',
    `        run: ${PUBLISH_COMMAND}`,
    '        env:',
    '          OPENCITADEL_MASTER: ${{ vars.OPENCITADEL_MASTER }}',
    '          OPENCITADEL_SIGNING_KEY: ${{ secrets.OPENCITADEL_SIGNING_KEY }}',
    '          OPENCITADEL_SIGNING_PASSPHRASE: ${{ secrets.OPENCITADEL_SIGNING_PASSPHRASE }}',
    '',
  ].join('\n');
}

function pascal(id: string): string {
  return id.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

function hostFiles(id: string, name: string): Record<string, string> {
  return {
    'plugin.json': json({
      id,
      name,
      version: '0.1.0',
      kind: 'host',
      description: 'Describe what your plugin does.',
      main: 'dist/index.js',
      engines: { opencitadel: `^${HOST_VERSION}` },
      permissions: ['server.chat'],
      config: { greeting: { type: 'string', default: 'Hello', description: 'What to greet players with' } },
    }),
    'package.json': json({
      name: id,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: { build: 'tsc', pack: 'citadel-host plugin pack .' },
      devDependencies: { '@opencitadel/plugin-sdk': `^${HOST_VERSION}`, typescript: '^5.9.0', '@types/node': '^22.0.0' },
    }),
    'tsconfig.json': json({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        outDir: 'dist',
        rootDir: 'src',
        skipLibCheck: true,
      },
      include: ['src'],
    }),
    'src/index.ts': `import { definePlugin } from '@opencitadel/plugin-sdk';

interface Config {
  greeting: string;
}

export default definePlugin<Config>({
  setup(ctx) {
    ctx.on('player.connected', ({ player }) => {
      void ctx.server.tell(player, \`\${ctx.config.greeting}, \${player.name}!\`);
    });

    ctx.commands.register('hello', {
      description: 'Say hello back',
      handler: (cmd) => cmd.reply(\`\${ctx.config.greeting}, \${cmd.player?.name ?? 'console'}!\`),
    });

    ctx.log.info('${name} loaded');
  },
});
`,
    'README.md': `# ${name}

An OpenCitadel host plugin.

\`\`\`sh
npm install
npm run build
citadel-host plugin pack .          # → ${id}-0.1.0.tgz
citadel-host plugin install ./${id}-0.1.0.tgz   # try it on your server
citadel-host plugin publish . --api-key ock_…   # share it on the registry
\`\`\`

Or publish from CI: \`.github/workflows/release.yml\` builds, signs and publishes on every \`v*\` tag
with trusted publishing (no registry key in the repository). Its header lists the one-time setup.

See docs/PLUGINS.md in the OpenCitadel repository for the full API.
`,
  };
}

function deadworksFiles(id: string, name: string): Record<string, string> {
  const cls = pascal(id);
  return {
    'plugin.json': json({
      id,
      name,
      version: '0.1.0',
      kind: 'deadworks',
      description: 'Describe what your plugin does.',
      assemblies: [`bin/Release/net10.0/${cls}.dll`],
      engines: { deadworks: '*' },
    }),
    [`${cls}.csproj`]: `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>${cls}</RootNamespace>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <DeadlockDir Condition="'$(DeadlockDir)' == ''">C:\\Program Files (x86)\\Steam\\steamapps\\common\\Deadlock</DeadlockDir>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="DeadworksManaged.Api">
      <HintPath>$(DeadlockDir)\\game\\bin\\win64\\managed\\DeadworksManaged.Api.dll</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="Google.Protobuf">
      <HintPath>$(DeadlockDir)\\game\\bin\\win64\\managed\\Google.Protobuf.dll</HintPath>
      <Private>false</Private>
    </Reference>
  </ItemGroup>
</Project>
`,
    [`${cls}.cs`]: `using DeadworksManaged.Api;

namespace ${cls};

public class ${cls} : DeadworksPluginBase
{
    public override string Name => "${name.replace(/"/g, '')}";

    public override void OnLoad(bool isReload)
    {
    }

    [Command("hello", Description = "Say hello")]
    public void CmdHello(Caller caller)
    {
        caller.Reply($"Hello, {caller.Name}!");
    }
}
`,
    'README.md': `# ${name}

A Deadworks plugin packaged for OpenCitadel. Build it with the .NET 10 SDK against a Deadlock
install that has Deadworks (\`dotnet build -c Release -p:DeadlockDir=...\`), then:

\`\`\`sh
citadel-host plugin pack .
citadel-host plugin publish . --api-key ock_…
\`\`\`

\`citadel-host plugin install ${id}\` copies the assemblies listed in plugin.json into
\`game/bin/win64/managed/plugins/\`, where Deadworks loads them.
`,
  };
}

function contentFiles(id: string, name: string): Record<string, string> {
  return {
    'plugin.json': json({
      id,
      name,
      version: '0.1.0',
      kind: 'content',
      description: 'Describe the maps or mods this package adds.',
      content: [{ file: 'pak01_dir.vpk', client: true }],
      maps: [],
    }),
    'README.md': `# ${name}

An OpenCitadel content package. Put your compiled VPKs next to plugin.json and list them under
\`content\`:

- maps: add the map name to \`maps\` and the file as \`maps/<name>.vpk\` (installed to
  \`game/citadel/maps/<name>.vpk\`, loadable with \`map <name>\`);
- everything else (VData changes, models, sounds): any \`.vpk\`, mounted through the
  \`citadel/opencitadel\` search path.

Mark files players need with \`"client": true\`; servers running this package advertise them,
and \`citadel-browser\` downloads and verifies them before joining.
`,
  };
}

/** Writes a new plugin project into `dir` (which must be empty or absent). Returns the files written. */
export async function scaffoldPlugin(dir: string, opts: ScaffoldOptions = {}): Promise<string[]> {
  const root = resolve(dir);
  if (existsSync(root) && (await readdir(root)).length) throw new Error(`${root} is not empty`);
  const id = opts.id ?? basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!PLUGIN_ID.test(id)) throw new Error(`"${id}" is not a valid plugin id (3-48 chars of a-z, 0-9 and -); pass --id`);
  const name = opts.name ?? id.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  const kind = opts.kind ?? 'host';
  const files = kind === 'host' ? hostFiles(id, name) : kind === 'deadworks' ? deadworksFiles(id, name) : contentFiles(id, name);
  files['.github/workflows/release.yml'] = releaseWorkflow(id, kind);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return Object.keys(files);
}
