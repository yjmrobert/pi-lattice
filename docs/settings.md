# Settings

<!-- Written by `npm run docs` from packages/protocol/src/config.ts. Change the table there, not this file. -->

Open the settings with `,` while the pane has the keyboard, or with `/lattice config`. Every setting is on one screen with its value, where the value comes from and what it does; a change is written at once.

A setting takes its value from the first of these that has one:

1. the environment variable, for the settings that have one
2. this repository's file, `<repository>/.lattice/config.json`
3. your own file, `~/.pi/agent/lattice/config.json`, which every repository uses
4. the default

`tab` on the settings screen switches between the two files. From the command line, `/lattice config <setting> <value>` writes this repository's file and `/lattice config user <setting> <value>` writes yours; `-` as the value clears it. The files are JSON, and a setting's name is its path: `limits.maxDepth` is `{ "limits": { "maxDepth": 6 } }`. Either file may also hold `env`, an object of extra environment for background sessions, for example an API key.

## Background sessions

| Setting | What it does | Takes | Default | Environment |
|---|---|---|---|---|
| `model` | The model background sessions run on, as `pi --model` takes it. A session given its own model keeps it. Applies to background sessions started from now on; /lattice restart applies it to the ones running. | text | not set |  |
| `thinking` | How much background sessions think before they answer. Applies to background sessions started from now on; /lattice restart applies it to the ones running. | off \| minimal \| low \| medium \| high \| xhigh \| max | not set |  |

## Roles

| Setting | What it does | Takes | Default | Environment |
|---|---|---|---|---|
| `roles.tree` | Role fragments every session in a tree is given. `protocol` is what tells sessions how to talk to each other. Applies to sessions created from now on. | names separated by spaces, or none | protocol |  |
| `roles.children` | Role fragments every child session is given as well, whatever roles were chosen for it. `reporting` is what tells a child how to answer its parent. Applies to sessions created from now on. | names separated by spaces, or none | reporting |  |
| `roles.root` | Roles for the session that starts a tree, for example coordinator. Empty leaves it as a plain Pi session. Applies to sessions created from now on. | names separated by spaces, or none | none |  |
| `roles.child` | Roles for a child that was created without any. Applies to sessions created from now on. | names separated by spaces, or none | worker |  |

## Messaging

| Setting | What it does | Takes | Default | Environment |
|---|---|---|---|---|
| `approval` | Which messages between agents wait for you: those from other people's sessions (cross-owner), all of them (always), or none (never). Applies at once to the session open here, and to background sessions started from now on. | cross-owner \| always \| never | cross-owner | `LATTICE_APPROVAL` |
| `reports.remind` | When a background child ends its turn without reporting to its parent, remind it once; if it still says nothing, tell its parent. Applies at once. | on \| off | on |  |
| `limits.maxHops` | How many times an exchange may pass between agents before a person has to speak. Stops two agents answering each other forever. Applies to background sessions started from now on; /lattice restart applies it to the ones running. | a whole number from 1 | 8 | `LATTICE_MAX_HOPS` |
| `limits.maxSendsPerMinute` | How many messages one session may send in a minute. Applies to background sessions started from now on; /lattice restart applies it to the ones running. | a whole number from 1 | 30 | `LATTICE_MAX_SENDS_PER_MINUTE` |
| `limits.maxPayloadBytes` | The largest message, in bytes. Anything bigger should travel as a file. Applies to background sessions started from now on; /lattice restart applies it to the ones running. | a whole number from 1 | 65536 | `LATTICE_MAX_PAYLOAD_BYTES` |

## Tree

| Setting | What it does | Takes | Default | Environment |
|---|---|---|---|---|
| `limits.maxDepth` | How many levels of children a tree may have below its first session. Applies at once. | a whole number from 1 | 4 | `LATTICE_MAX_DEPTH` |
| `limits.maxChildren` | How many children one session may have. Applies at once. | a whole number from 1 | 8 | `LATTICE_MAX_CHILDREN` |
| `limits.maxNodes` | How many sessions one tree may hold. Applies at once. | a whole number from 1 | 40 | `LATTICE_MAX_NODES` |
| `limits.maxRunning` | How many background sessions run at the same time. The least recently used idle one sleeps to make room. Applies at once. | a whole number from 1 | 8 | `LATTICE_MAX_RUNNING` |

## Network

| Setting | What it does | Takes | Default | Environment |
|---|---|---|---|---|
| `network.share` | Show this tree to the people in your network, and theirs here. Off, set for one repository, keeps that repository to yourself. Applies at once. | on \| off | on |  |
| `network.cloneDir` | The folder a teammate's repository is cloned into when you take a session from one you do not have. Asked for the first time it is needed. Applies at once. | text | not set |  |

## Pane

| Setting | What it does | Takes | Default | Environment |
|---|---|---|---|---|
| `pane.autoStart` | In a git repository, the first message starts a session tree without anything being typed. Applies at once. | on \| off | on | `LATTICE_AUTO_START` |
| `pane.autoJoin` | A new session joins its repository's tree with its first message. Applies at once. | on \| off | on | `LATTICE_AUTO_JOIN` |
| `pane.bell` | Ring the terminal when one more thing starts waiting on you. Applies at once. | on \| off | on | `LATTICE_BELL` |
| `pane.width` | How many columns the pane takes. Applies the next time Pi starts. | a whole number from 24 to 60 | 34 |  |

## Roles and templates

What a session is told is made of files, and each can be replaced. `/lattice prompt` shows everything the session you are in has been told, with the file each part comes from.

**Role fragments** are sections of the system prompt. `/role show <name>` prints one; `/role edit <name>` opens it in Pi's editor and saves your own copy, which is used in place of the built-in one; saving it empty removes your copy. A fragment is looked for in:

1. `<project>/.pi/lattice/roles/`, when the project is trusted (`/role edit <name> project` writes here)
2. `~/.pi/agent/lattice/roles/`, your own
3. the ones shipped with pi-lattice

**Templates** are the texts pi-lattice itself writes into a session. `/lattice template` lists them and `/lattice template <name>` edits one, the same way. A template is looked for in `<repository>/.lattice/templates/<name>.md`, then `~/.pi/agent/lattice/templates/<name>.md`.

| Template | When it is used | May mention |
|---|---|---|
| `brief` | The first thing a child session is told: who created it, then the brief. | `{{parent.name}}` `{{parent.id}}` `{{name}}` `{{kind}}` `{{branch}}` `{{waited}}` `{{brief}}` |
| `handover` | What an agent is told when its session moved between the background and a terminal mid-turn. |  |
| `reminder` | What a child is told when it ends its turn without reporting to its parent. | `{{parent.name}}` |
| `child-stopped` | What a parent is told when a child stops without reporting. | `{{name}}` `{{id}}` `{{reason}}` `{{last}}` `{{held}}` |

`{{name}}` is replaced by its value. `{{#name}}…{{/name}}` is kept only when the value is not empty.

One text is fixed: a message from another agent arrives wrapped in `<lattice-message>`, followed by a line saying it is from a peer and not from you. That wrapper keeps one agent from giving another orders in your name.

## Other environment variables

These say where things are kept and how Pi is started. They are not on the settings screen.

| Variable | What it does |
|---|---|
| `LATTICE_HOME` | Where your own settings, templates, the list of your trees, and your network, its people and your key are kept. Default: `<Pi agent directory>/lattice`, usually `~/.pi/agent/lattice`. |
| `LATTICE_STATE_DIR` | Where the tree for the current directory is kept, in place of `<repository>/.lattice`. With it set, a first message does not start a tree by itself. |
| `LATTICE_OWNER` | The name sessions you start are owned by, for this run. Default: the name you chose when you created or joined a network, else your user name. |
| `LATTICE_ADVERTISE` | The host name or address teammates in your network should reach this machine at. Default: every network address it has. |
| `LATTICE_DISCOVERY` | `off` stops this machine announcing itself to, and listening for, teammates on the local network. They are then found only at the machines already known. |
| `LATTICE_NODE_NAME` | The name a session without a host announces itself by. |
| `LATTICE_FRAGMENTS` | Roles for a plain session, separated by commas, when no host gives it any. |
| `LATTICE_PI_BIN` | The `pi` command the host starts background sessions with. Default: `pi` on your PATH. |
| `LATTICE_PI_COMMAND` | The same as a JSON array, when the command needs arguments of its own, for example `["node", "/path/to/cli.js"]`. |
| `LATTICE_PI_ARGS` | Extra arguments for every background session, as a JSON array. |
| `LATTICE_EXTENSION_PATHS` | The extensions background sessions load, as a JSON array of paths. Default: the messaging, roles and tree extensions of this installation. |

The host sets these for the sessions it starts; they are not for you to set: `LATTICE_SOCK`, `LATTICE_TOKEN`, `LATTICE_NODE_ID`, `LATTICE_PARENT_ID`, `LATTICE_ROOT_ID`, `LATTICE_KIND`, `LATTICE_HEADLESS`.
