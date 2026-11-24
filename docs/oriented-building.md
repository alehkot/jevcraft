# Building with Jev

Ask **“Jev, help me build a small house for three.”** The starter layout has a living room, a bedroom, an exterior and interior door, a roof, two glass windows, a stair sofa, a chest, floor torches and a bed for each person. Two beds are the default. You can drop supplies while Jev works. **“Jev, you forgot the door”** and **“Jev, add windows and torches to the house”** update the nearby house in Jev’s building records. **“Jev, craft a door”** makes the item.

With no material named (**“Jev, build us a house”**), Jev builds the floor, walls and roof from whatever blocks are quickest. It uses what it carries first (dirt, cobblestone, then planks it can spare), then one block it gathers nearby: cobblestone when it has a stone pickaxe and open stone is close, otherwise dirt. Grass under the house stays as its floor, and blocks a player sets into the walls are kept. Doors, windows, beds and furniture are built as drawn. Name a material (**“a spruce house”**, **“a stone house”**) to build all of it from that.

**“Jev, add a room to the house”**, **“add a bedroom”** or **“extend the house”** adds a small room beside a house in Jev’s records, on a side away from its front door. The room has a window, a torch, a bed when you ask for a bedroom, and a door through the shared wall. To add a room to your own house, stand inside it, look at an outside wall and ask the same. Jev plans the room on that side and cuts the doorway through your wall, unless you ask it not to (“…but don’t cut my wall” with the request, or “Jev, don’t cut my wall” before it gets there); then it waits for you to break the two blocks yourself.

**“Jev, build a house”** asked from inside walls you have started and not yet roofed, or **“finish my house”**, **“build a house on my walls”** or **“put a roof on my hut”** from in or beside them, makes the house out of what you built instead of next to it. Jev gives your blocks to the designer with the request, checks each draft against them block by block, and sends back any draft that would lose one, naming the blocks, until a draft keeps them all. Not one of your blocks is dug, replaced or counted as Jev’s: the house is placed exactly over them and only the missing parts are built. Walls with no way in get one door through them: Jev cuts that doorway, unless you ask it not to in the same way, and then waits for you to open it. After three drafts that do not fit, a house you only asked for goes up next to yours, while one you asked Jev to finish waits for **“Jev resume”** to try again. Jev tells your dirt, logs and stone from the ground’s by having seen a player place them; walls built while it was away are recognised from their made blocks (planks, cobblestone, glass, doors and the like). Asked from outside your walls, “build a house” builds a separate one.

In Survival and Creative, `BUILD_DESIGNER=auto` sends the requested location, observed biome, terrain heights, surface materials, water, lava and inventory to the configured schematic model. It uses OpenRouter when an OpenRouter key is configured, then the guide provider when its key is configured. `BUILD_DESIGNER=guide` selects the guide provider explicitly. `JEV_BUILD_MODEL` can select Terra, Luna or another model offered by the provider. `BUILD_DESIGNER=jev` uses the built-in plans. Starter houses are drawn in local wood, or sandstone on sandy sites. With no material named, that is only the last resort for the shell. A wood named in chat takes priority.

Jev travels to an unloaded requested site to observe its terrain before drawing. For a two- or three-person house, it checks that the front door leads to a clear aisle, the bedroom door opens onto a reachable room, and the beds, sofa and chest can be used. Jev saves the drawing before review and the approved layout and site before construction. **“Jev stop”** followed by **“Jev resume”** continues that drawing. Each bed can use a different available color. A player’s unexpected block in a work space pauses construction and Jev identifies its coordinates.

**“Jev, put two torches beside the closest crafting table to me”** or **“Jev, put a chest next to the closest tree to me”** places the items on nearby supported ground. Jev measures from the speaker when the request arrives and remembers that spot through a stop or a trip for supplies.

**“Jev, light up this room”** checks for ground that would be dark at night. Light travels through openings and around corners. **“Jev, climb down the ladder”** uses a supported ladder with landings. **“Jev, come to me by boat”** uses a boat where Jev can find a connected water route and a safe bank.

## Home and respawn

**“Jev, where is home and where will you respawn?”** reports both locations with coordinates and dimensions. **“Jev, set my home here”** marks a personal home, and **“Jev, where is my home?”** gets the coordinates in a whisper. **“Jev, set our home here”** or **“Jev, set home here”** marks the shared home at the speaker’s position. **“Jev, go to my home”** and **“Jev, go to our home”** select the destination explicitly. **“Jev, forget my home”** removes the speaker’s marker. Personal markers made by older versions stay in their owner’s notebook. To share an older marker, stand there and say **“Jev, set our home here”** once.

For **“Jev, go home,”** Jev checks the speaker’s personal home, the shared marker, its established base and its first recorded completed house, in that order. Until it has a home, Jev uses world spawn as a temporary meeting place.

The optional Paper 26.2 plugin in `paper/locations` answers a connected client about its own validated personal point, world spawn and effective respawn destination. It reads EssentialsSpawn’s group-spawn rule when that plugin controls the destination. It records the actual landing after death. A server with a randomized or unrecognized policy can supply the actual landing after respawn. On a server without the plugin, Jev reports its last known point from Minecraft’s packets and confirmed bed interactions.

To build the plugin against an installed Paper server, use its JDK and run `bash paper/locations/build.sh /path/to/paper /tmp/JevcraftLocations.jar`. Put the jar in that server’s `plugins` directory and restart Paper.

The Pi field notes include the production respawn rule and commands for rerunning each private test. [Pi Paper field notes](pi-paper-notes.md)

## Stairs and slabs in custom builds

The building advisor can now include stair and slab regions in arbitrary designs.
The same deterministic executor handles them in Survival and Creative. Jev still
routes the player's request; block states, material counts, placement, and final
verification stay in code.

Each region has optional `properties`. Existing full-block schematics without
that field remain valid. New advisor responses use `null` for full blocks and air:

```json
{
  "from": [1, 1, 1],
  "to": [3, 1, 1],
  "block": "oak_stairs",
  "properties": { "facing": "south", "half": "bottom" }
}
```

Stairs require `facing` (`north`, `east`, `south`, or `west`) and `half` (`bottom`
or `top`). Facing points toward the high side of a bottom stair; north is negative
Z and east is positive X. Slabs use `facing: null` and `half: "bottom"` or `"top"`.
The executor translates slab half into Minecraft's `type` property. Each planned
cell consumes one item in Survival; there are no double-slab cells. Neighboring
stairs form corner shapes automatically. The schematic does not override those
derived shapes, request waterlogging, or supply arbitrary state IDs.

The foundation layer uses full blocks. [Wooden doors](doors.md) also have explicit
placement and verification; other oriented families remain outside the palette.
Entrance and interior diagnostics still use
an approximate cell walk graph; exact block-state verification does not prove
that every possible generated interior is navigable.

## Placement and resuming

- Work destinations include the required look direction and a visible click
  point on the correct half of a real collision face.
- Placement uses that same click point. It avoids clicks that would merge a
  neighboring slab into a double slab.
- Standing on a slab uses the actual collision height when evaluating reach.
- Building batches order supports before dependent trim, including beams above
  upside-down slabs. Execution prefers low layers but can build another reachable
  support in the batch when a lower piece cannot yet be attached.
- Survey translation, material batches, checkpoints, and final checks retain
  the intended states. A wrong-facing stair is unfinished even if its material
  matches. The bot may repair its own recorded misplacement; unowned changes at
  the site remain protected.

## Validation

`test/build-blocks.test.js`, `test/build-batch.test.js`, and the construction and
designer tests cover orientation, placement faces, half-slab footing, material
counts, capacity-limited support ordering, old schematic compatibility, and
protection of player edits.

The real-server fixture is:

```sh
MC_PORT=<isolated-port> node scripts/oriented-building-test.js
```

Run the generated artifact directory's `setup.json` commands in that isolated
server's console, then create its `ready` file. The script builds a gallery with
all eight stair orientation/half combinations, both slab halves, adjacent slabs,
a hanging slab that depends on a higher beam, and an ordinary staircase. It
stops after two stairs, reloads its checkpoint, finishes construction, and walks
up the staircase without jumping. A separate client verifies states and motion.
Supplies, terrain, and starting positions are granted: this is a controlled
mechanics test, not a natural Survival progression result. Ports 25565 and 25577
are explicitly rejected.

An interrupted fixture can be retried with `RESUME_BUILD_DIR=<artifact-directory>`.
For an arbitrary retained advisor design, set
`BUILD_SOURCE=test/fixtures/oak-stair-pavilion.json` and optionally
`BUILD_MODE=creative`. `TEST_REPAIR=1` pauses at `repairSetup`; apply the generated
`repair-setup.json` and create `repair-ready`. This deliberately records a wrong
fixture stair as bot-owned and verifies that resume corrects it.

On 2026-09-19, the live advisor returned the retained 135-block pavilion with 40
stairs and nine slabs using the new schema. Controlled Creative run
`oriented-building-mu8nuqdk` built it, resumed after cancellation, repaired the
deliberately reversed stair, and passed independent verification of all 49
oriented cells with health 20. The Survival gallery in
`oriented-building-mu8novpa` exposed the half-slab eye-height bug, then completed
from its saved checkpoint after the fix: 108 blocks, 15 oriented cells, and a
successful staircase walk without jumping. Artifacts are local and ignored by Git.

A fresh Survival run, `oriented-building-mu8nywan`, then passed the complete
108-block gallery from scratch, including cancellation/resume, the higher-beam
dependency, and the independently observed stair walk. The automated suite passed
400 tests on the supported bundled Node runtime.
