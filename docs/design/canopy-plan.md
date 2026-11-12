# Canopy: the plan

A full-screen view of the work of a network, drawn as a tree that grows upward: the network at the root, then epics, features and stories, with tasks as leaves. The mockup is [`overview/canopy.html`](overview/canopy.html). This plan says how to build it, what it must show without ambiguity, which animations it has and why, and what happens at the edges.

Status: phases 0 to 2 are built ([0022](../decisions/0022-canopy-in-pi.md), [0023](../decisions/0023-planned-work.md), [0024](../decisions/0024-the-canopy.md)), with the people bar, spotlight, roster, tethers, panning and folding from later phases. Not built: animations of events, answering in place, zoom, the map, find, follow, the fallbacks for poorer terminals, the network phase and pixels.

## What the screen must answer at a glance

1. **Who owns this?** For any item and any agent, which person.
2. **Which agent is working on which item?** And which items have nobody.
3. **What needs someone?** A question, an approval, an offer.
4. **How far along is it?** Per branch, without reading numbers.

Everything below is judged against these four.

## The model

A work item is a node. A session is whoever sits on it. The tree already separates the two ([0004](../decisions/0004-node-identity.md)), so the canopy needs additions, not a second store.

- **Levels are a setting, not an enum.** `canopy.levels`, default `epic feature story task`. A node's level is where its `kind` falls in the list. Kinds stay free-form strings.
- **An item can be planned.** A node created with no session and no brief delivered. Today the only node like this is one that waits on others ([0021](../decisions/0021-waiting-on-other-sessions.md)); planning generalises it. `s` seats a session on it, through the form the pane already has.
- **One seat per item.** At most one session sits on a node, as today. A coordinator sits on an epic, a planner on a feature, a worker on a task. The seat is where an agent belongs and what it answers for; it does not change.
- **An agent also has a focus: the item it is attending to now.** A coordinator seated on an epic spends a while on one story, then another. The host learns this the way it learns status and activity today: it is not reported by the agent, it is read from what the agent does. The host already sees each tool call a background session starts. When that call is a lattice one (`spawn_session`, `plan_item`, `send_message`) its target is the focus; a message arriving from below sets it too. A session open in a terminal reports it from that terminal, as it reports usage. A focus carries its time and fades: after a few minutes without a touch the agent is simply at its seat. A worker's focus is its own task.
- **Helpers are buds.** A child whose kind is not in the ladder (`verify`, `review`, `grilling`) is not a level. It is drawn as a bud on the item it serves, with its own agent.
- **Done is recorded, progress is derived.** `done` on a node already means it reported its result. An item's progress is the share of its leaves that are done. Where the two disagree (an epic reported done with tasks still open) the canopy shows the mismatch; it does not hide either.
- **Owner is per node**, as now. The owner's host runs the node's session ([leases](../leases.md)). So an agent's owner is the owner of the item it sits on: one fact, shown once.
- **Items come from agents first.** `graph` gains `plan_item` beside `spawn_session`; the coordinator role is told to lay out the work before starting it. People add items with `n`. Importing from a tracker is left out; it would sit behind an interface the canopy defines.

What a tree from before this looks like: a root session of kind `feature` with `task` children maps onto the ladder as it is. A root whose kind is not in the ladder is treated as the top level.

## The shape: grown, not ruled

Height still means level: an epic is below its features, a feature below its stories, tasks are at the tips. But the levels are bands, not lines, and the tree is allowed to look like one.

- **A band, not a row.** An item sits somewhere within its level's band. A subtree with more under it reaches higher and spreads wider; a planned story with two tasks stays low and small. A child is always above its parent.
- **Branches lean and sway.** A branch leaves its parent at an angle that depends on how many siblings it has, and bends on the way. Thickness follows how much work is above it: an epic's branch is heavier than a story's.
- **Leaves cluster.** Tasks fan round the end of their story at slightly different heights, not in a line.
- **It does not shuffle.** Every offset is computed from the item's id, so the same tree draws the same way each time, and adding an item moves its neighbours as little as possible. A tree that rearranged itself on every change could not be learnt.
- **Text stays level.** Labels are horizontal and in cells whatever the branch does, and never overlap: the layout reserves each label's cells before it bends anything.
- **`canopy.shape`: `grown`, `ruled`.** `ruled` puts every level on one row, as the mockup does, for those who prefer it.

## Where it lives

A new package, `packages/canopy`, depending only on `protocol` ([0014](../decisions/0014-package-seams.md)). `app` wires it in. Inside it, three layers, the first two free of Pi so they are tested without a terminal:

| Layer | Takes | Gives |
|---|---|---|
| `layout` | nodes, levels, width, height, what is folded | positions in cells, branch paths, what did not fit |
| `paint` | a layout, the time, the running animations | a grid of cells: character, colour, brightness |
| `screen` | the grid | the terminal, through Pi; keys back |

- The pane stays as it is: the always-on rail at 34 columns, where things are answered. The canopy is opened from it (`c` in the pane, `/lattice canopy`) and closed with `esc` or `alt+l`. Both show the same nodes; the selection carries across.
- The pane asks for the canopy on the event bus (`lattice:canopy:open { nodeId }`). It does not import it. Without the canopy package the key does nothing and says so.
- The canopy reads the same `UiState` the pane reads, from every host the pane is connected to, plus what teammates have elsewhere ([0019](../decisions/0019-everything-everyone-is-running.md)).

## Seeing who owns what, and who works where

Three channels, each carrying one thing. They never share.

| Channel | Carries | Rule |
|---|---|---|
| **Hue** | the person | A person has one colour everywhere: their branches, their agents' rings, their name. Nothing else uses those hues. |
| **Shape and motion** | the agent and its state | A ring around a node means an agent sits there. Turning: working. Still: idle. Hollow node, no ring: nobody. |
| **One reserved colour** | needs someone | Amber is kept for attention and given to no person. It is the only thing on the screen that blinks. |

The mockup breaks the first rule: `@sam` is amber and so is "asks". The palette is fixed so that cannot happen: eight person hues, none of them amber, red or the root's magenta. Red is for failed.

**On the canopy**

- A branch is drawn in the colour of the owner of the item it leads to. Where ownership changes along a path (a story owned by `@teo` under an epic owned by `@yan`), the colour changes at that node and the label carries the name, so it is never colour alone.
- An agent is a ring in its owner's colour with a chip under the item: `⠹ planner`. The chip is the session's role, or its name when it has no role. A task leaf with an agent shows its state glyph in the owner's colour.
- An item with an owner and no agent is a hollow node in the owner's colour: owned, nobody working. This is the state the pane cannot show today.
- An agent whose focus is not its seat is tied to it: a thin line in its owner's colour from the ring to the item it is attending to, with a small copy of its marker at the far end. The seat says whose agent it is and what it answers for; the tether says where it is working this minute. The tether thins as the focus ages.
- The node open in your terminal is marked `▸`, as in the pane.

**The people bar** (top line). Each person: colour, name, presence, and three counts: agents working, agents asking, items owned.

- `1`–`9` spotlights a person: everything they do not own drops to grey, their path from the root stays lit. `0` clears. This is the fastest answer to "what is Sam running".
- A person who is away keeps their colour at half strength; their rings stop. What is shown is what was last heard, with its age.

**The roster** (side panel, `a`). The same facts as a table, for when position is not enough:

```
 @sam  Billing                 ⠹3 ●1
  ⠹ coordinator   pricing-migration   epic
  ○ planner       tables              story
  ⠹ worker        tables ▸ copy       task
  ● worker        export ▸ pdf        task
 @teo  Mobile  away 2h         ●1
  ● worker        offline ▸ conflicts task
```

Moving in the roster moves the selection on the canopy, and the other way round. Sorted by person, then by what needs someone.

**The inspector** (side panel, default). For the selected item: owner, who sits there with role, model and what it last did (the `activity` line the pane has), progress, children, what it waits on, what waits on it. For a teammate's agent it is kept up to date while selected, as in the pane.

## Animation

Every animation is the picture of one event. Nothing moves when nothing happened: an idle network is a still screen. The climbing wave in the mockup is decoration and is dropped.

| Event | What moves | For how long |
|---|---|---|
| An agent is working | its ring turns | while it works |
| A message between two sessions | a pulse runs along the branches from sender to receiver, in the sender's owner's colour. A brief goes up, a result comes down | about a second |
| A task lands | the leaf flashes, then its branch lights from the leaf down to its parent. If that completes the parent, the light carries on down | 600 ms a segment |
| An agent's focus moves | its tether swings from the old item to the new one, and the small marker travels along it | 400 ms |
| Something starts needing someone | one amber ripple spreads from the node and the person's count in the people bar flashes. Then the node blinks amber, once a second | the ripple once; the blink until answered |
| An item is planned or spawned | its branch grows from the parent; neighbours slide aside | 400 ms |
| A waiting session starts | its wait arc drains into it and is gone | 500 ms |
| A handoff is offered | the branch alternates the two people's colours | until decided |
| A handoff completes | the new colour sweeps along the branch from the node | 600 ms |
| A person goes away | their branches fade to half strength | 400 ms |
| A session fails | nothing moves. The node becomes a red `✗` and stays | — |

- **Where events come from.** The host already says "changed"; the canopy compares the new state with the last and derives landing, planning, starting, handoff, presence and a moved focus from the difference. Messages are the one thing a difference cannot show, so `UiState` gains `traffic`: the envelopes of the last few seconds, as from, to, intent and time. No content.
- **Opening the canopy plays nothing.** It draws the present. Only what changes while it is open animates, so a first look is not a firework.
- **Many at once.** Events on the same branch queue; more than a handful of pulses a second on one branch merge into one.
- **Budget.** Twelve frames a second, and only changed cells are written. With nothing animating the canopy writes nothing.
- **Attention off screen.** When what needs someone is outside the view, the edge of the screen nearest to it carries an amber arrow with a count, blinking in step. `tab` goes there.
- **`canopy.motion`: `full`, `calm`, `off`.** `calm` keeps the rings and the amber blink, drops the ripple, and makes everything else a single-frame change. `off` is fully static: state is still told by glyph. `NO_COLOR` and a dumb terminal imply `off`.

## Interaction

| Key | Does |
|---|---|
| `←` `→` | beside, on the same level |
| `↑` `↓` | to the first child, to the parent |
| `tab` | the next thing that needs someone |
| `enter` | open the agent sitting here in this terminal (as the pane does); on a folded item, unfold |
| `s` | seat a session on a planned item; twice on a working one, stop it |
| `n` | add an item below |
| `y` `n` `a` `x` | answer what the selected item asks, in place |
| `o` `t` | offer it, ask for it |
| `shift` + arrows | pan the view. `home` centres on the root |
| `F` | follow: the view stays on the selected agent, and moves with its focus. Any pan stops it |
| `m` | the map: the whole tree small in a corner, with the view as a frame |
| `z` | zoom: the selected item becomes the root. `z` again, or `esc`, goes back |
| `f` | fold or unfold the selected item |
| `1`–`9`, `0` | spotlight a person, clear |
| `a` | roster or inspector in the side panel |
| `/` | find an item or an agent by name |
| `esc`, `alt+l` | back to the pane |

The keys the pane already has keep their meaning. `n` is both "no" and "add": as in the pane, the answer keys apply only while the selected item is asking.

## Edges

**Size**

- **The tree is as big as it needs to be; the screen is a window on it.** Every item gets the room its label needs, and the canopy is laid out at that size whatever the terminal. The view pans over it, up and down as well as sideways.
- **The camera follows the selection.** Moving to an item outside the view glides the view to it (one step in `calm`). It moves only as far as needed to bring the item and its parent in, so small moves do not swing the whole screen. `F` follows an agent instead, including when its focus moves.
- **Where you are.** A one-line trail at the top names the path from the root to the selection. `m` shows the map. Branches that leave the view end in a mark at the edge saying what is beyond and how much.
- **Opening** shows the whole tree when it fits. When it does not, it opens on the node open in your terminal with its epic in view.
- **Folding is a choice, not a rescue.** `f` folds an item to one node with counts. Nothing folds by itself.
- **Many tasks under one story** (more than fit a fan): counts by state (`✓12 ⠹2 ○5`); selecting the story lists them.
- **The floor is 60 columns by 20 rows**, below which a label and its branch cannot both be read. There the canopy says so and the pane stays.
- **Names** longer than 24 characters are cut with `…`; the inspector has the full name.
- **Resize** keeps the selection in view and draws once, without animation.

**Shape of the tree**

- **One item only, or none.** The root with a line saying how work is added. No empty tree drawn.
- **A level is skipped** (a task directly under an epic): drawn on its own level's row with a longer branch.
- **A kind is not in the ladder**: a bud on its parent. A root not in the ladder: top level.
- **Deeper than the ladder**: what is below the last level is a bud.
- **Several repositories.** The root is the network; an epic names its repository. Without a network the root is the repository, or "your work" when there are several.
- **Archived items** are not drawn. `A` shows them greyed.

**State**

- **An agent exits without a result.** `✗`, and anything waiting on it shows its arc in red. Nothing starts by itself, as 0021 decided.
- **Reported done with open leaves.** Shown as done with the count of what is open beside it.
- **A planned item whose parent is done.** Drawn as planned; the mismatch above covers it.
- **An agent open in someone's terminal** cannot be stopped or taken from under them; the keys say so, as the pane does.
- **Waits across people** do not exist yet (0021). No arc is drawn for anything the host does not record.

**People**

- **More people than colours.** Eight get a hue. From the ninth, people share hues and are told apart by a letter on the node. The letter is always available (`i` shows it for everyone), so the screen can be read without colour.
- **A teammate's tree that was last heard hours ago** is drawn at half strength with its age on their name in the people bar.
- **A repository that is not on this machine**: its items are drawn; `enter` reads, `t` asks and clones, as in the pane.
- **`network.share` off** for a repository: it is not in anyone else's canopy.

**The terminal**

- **Braille is missing or the wrong width** in the font: branches fall back to box characters (`│ ╰─╮`), right-angled. Chosen with `canopy.branches`: `braille`, `box`, `pixels`; the default is found at start.
- **Glyphs of uncertain width** (`⧗`, `◉`) misalign a cell grid. Only glyphs measured as one column in the terminals tested are used; the list is in one place.
- **Sixteen colours or fewer**: people get the eight named colours; brightness steps become bold and dim.
- **A slow link.** Only changed cells are written, and frames are dropped, never queued.
- **Pi changes its internals.** The full-screen takeover is expected to rest on the same undocumented members the pane uses ([0013](../decisions/0013-pane-inside-pi.md)). If they are gone, `/lattice canopy` prints one still frame into the conversation.

## Build order

Each phase ends with its tests green, a decision record, and a push.

**0. Find out (spike, `spikes/canopy/`).** To verify, against real Pi: that an extension can take the whole screen and get every key; how often it may redraw; whether an image can be put under text (the pixel renderer depends on it); which glyphs are one column wide in kitty, ghostty, wezterm, iTerm2, the VS Code terminal and tmux. Ends with ADR 0022 stating what is possible.

**1. The model.** `protocol`: `canopy.levels`, a planned node, `traffic` and each agent's `focus` in the state. `host`: create without starting, seat later, record traffic, read focus from lattice tool calls. `graph`: `plan_item`. `roles`: the coordinator lays out the work. `pane`: planned items shown dim, `s` seats. Tested through a host and real Pi processes, as the waiting sessions were.

**2. A still canopy.** `layout` (grown and ruled) and `paint` with braille and box branches, the camera following the selection, the text grid, selection, the inspector, the keys, opening from the pane. Layout is tested as text: a tree in, a grid of characters out, compared with a stored file. The mockup's tree is the first of them.

**3. People and agents.** The palette, rings and chips, tethers to the focus, the people bar, spotlight, the roster, the letter for people past eight.

**4. Motion.** Animations from state differences, traffic pulses, the ripple and blink, attention at the edges, the queue, `canopy.motion`. Tested by feeding two states and reading the frames between.

**5. Scale.** Panning, follow, the map, the trail, folding, counts, zoom, find, the floor.

**6. The network.** Teammates' trees, away and age, offer and ask from the canopy, the handoff animations. Tested with two isolated hosts.

**7. Pixels.** Only if phase 0 says an image can sit under text. Same layout, another painter.

## Decided

- **A seat and a focus.** The seat is fixed and says whose agent it is. The focus is where it is working now, read by the host from what the agent does, never asked of the agent, and it fades when stale.
- **Height is the level of the work**, as bands. The tree is grown, not ruled, and draws the same way every time.
- **Amber is reserved** for "needs someone" and no person gets it. It arrives with a ripple, then blinks, and shows at the edge of the screen when out of view.
- **The canopy is a window on a tree of any size.** It pans both ways and the camera follows the selection, or an agent.

## Open

- **How long a focus lasts** before the agent is drawn back at its seat. Five minutes is a guess; it needs a day of real use.
- **Whether a focus should be settable by the agent as well**, with a tool, for work the host cannot see a target in (reading, thinking). Left out until the observed one proves too coarse.
