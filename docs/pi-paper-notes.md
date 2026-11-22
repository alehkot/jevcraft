# Raspberry Pi Paper field notes

These observations came from the Pi’s Paper 26.2 server and a Java 26.1 Mineflayer client through ViaBackwards on November 21, 2026. Recheck the coordinates after a world replacement and the respawn rule after an EssentialsSpawn configuration change.

| Symptom | What the Pi actually does | How to check |
| --- | --- | --- |
| Jev’s house and resurrection point differ | The recorded house entrance was `-1, 109, 45` in the Overworld. With `respawn-at-home: false`, EssentialsSpawn sends Jev to the configured group or server spawn. In this world that was `48, 106, 0`, even after Jev claimed a bed. | Ask `Jev where is home and where will you respawn?`. The `home` scene marks a home, claims a bed, reconnects, compares the predicted and actual death landing, then removes the bed. |
| A personal home is saved but the owner sees no reply | Essentials owns the unqualified whisper command on this Pi. A non-operator can use Paper’s vanilla `minecraft:msg` with the recipient’s player name. The player-only argument rejects a raw UUID. | The `home` scene sets, reads and forgets a personal marker through player chat and checks that its coordinates arrive privately. |
| A saved house plan says “complete” but its doorway is empty | The old 5×5 plank house intentionally left two air cells for the entrance. The new fitter uses the saved footprint and checks the real lower and upper door halves. An item request such as `craft a door` leaves the item in inventory. | Run `fittings craft`. Ask `Jev you forgot the door` to install one on the standing house. |
| A newly placed torch reads as zero light, or a torch across a wall looks close | The client’s light data can lag block changes. Jev uses observed light sources and connected openings. A wall can put the adjacent room in darkness. | The `lighting` scene checks the requested floor with a second client, checks the enclosed room on the other side of a wall, and repeats the request to check torch consumption. |
| The bot reaches the top rung and stalls there on descent | A player’s hitbox can rest on the top rung or the lip. Jev steps clear of the lip before releasing forward and descending. | The `ladder` scene places six supported, oriented rungs in Survival, then observes the upper and lower landings. |
| A previously usable ladder leads into a blocked landing | Players can change the landing while Jev is away. Jev checks the saved landings again before setting off. | The `ladder` scene blocks the lower landing between trips, checks that Jev stays at the top, then clears it for descent. |
| Jev cannot identify the nearest tree or crafting table for a test player | Jev needs the speaker’s position to resolve “closest to me.” A spectator may be invisible to the bot. A Survival observer left in a house footprint can also physically block construction. | The `landmarks` scene waits for Jev to see the speaker and checks both placed blocks from a second client. The `fresh` observer steps away once Jev records the requested site. |
| A client appears to paddle without proving the boat crossed | A second client can see the actual vehicle, rider and far bank. The driver also checks dismount and the recovered boat item. | Run `boat`. The review records mounted samples, farthest observed position and final inventory. |
| A resumed build reports unfamiliar dirt or cobblestone | Pathfinding can send temporary block placements while a work step ends. Paper reports successful placements by Jev. The builder keeps the entrance clear and can remove its own scaffold before placing the beds. An unrecognized player block pauses the build with its coordinates. | Run `fresh`, or `resume` for a saved private run. Check the coordinates, block owner and drawing before clearing anything on the live world. |

## Reusing the private Paper tests

From the Pi development checkout:

```bash
cd ~/jevcraft-dev
scripts/pi-paper/window.sh --check
scripts/pi-paper/window.sh fittings craft furnished
scripts/pi-paper/window.sh ladder landmarks lighting boat home
scripts/pi-paper/window.sh fresh
```

Run the window under `systemd-run --user --collect --unit=jev-paper-check` with the absolute path to the script if it needs to survive closing the terminal. `fresh` asks the configured model for a drawing through player chat, supplies Survival materials, stops and resumes the work, and verifies the final blocks. `furnished` replays a recorded Terra drawing against a supplied shell.

To check a stop across server restarts, run these commands in order. The middle command exercises an unrelated scene with its own world and inventory.

```bash
JEV_REVIEW_CHECKPOINT_ONLY=1 scripts/pi-paper/window.sh fresh
scripts/pi-paper/window.sh ladder
scripts/pi-paper/window.sh resume
```

`resume` opens the most recent unfinished model-drawn house, or the run named by `JEV_REVIEW_FROM`. It compares saved blocks and carried supplies before continuing and verifies the finished house with a second client. Each fresh run retains a full Paper copy under `~/jevcraft-paper-review/runs/<run>/paper/newworld`, including player data. Ordinary scenarios reuse `~/jevcraft-paper-review/fixtures/regular/newworld`. The original `~/jevcraft-paper-review/newworld` supplies the template and holds the world used by older checkpoints. Each run records the selected directory in `fixture.json` alongside its logs and bot state.

All private copies bind to `127.0.0.1:25575`. A host-wide lock serializes windows from every checkout. The runner checks occupancy on live Paper twice before stopping it. Its default window is 15 minutes, and the Bedrock join watcher restores the live server early when someone tries to connect. The live world is `~/minecraft/world`. Jev starts through `mc-companion-watch.service` when a player joins.

The host’s Java launcher and Bedrock join watcher live under `~/minecraft/tools/testcopy`. The test scenarios, window coordinator and recorded Terra fixture are in this repository under `scripts/pi-paper`. For offline regression coverage, run `bash .ci/check.sh` in a checkout with its own dependency directory. The Pi development checkout shares its dependencies with the live bot.

The Paper plugin source and build command are in `paper/locations` and `docs/oriented-building.md`. A private copy used for respawn testing should load the same Essentials and EssentialsSpawn configuration as live. A plain Paper copy can honor a bed that the live plugin configuration overrides.
