# Buckshot Roulette — Browser CLI

A lightweight browser recreation of the core single-player rules in Buckshot Roulette. It runs locally without a server, build step, or third-party packages.

## Run locally

Open `index.html` in a modern browser.

- Press Enter to start Story Mode.
- Beat Story Mode once to unlock Double or Nothing; after unlocking, enter `2` and press Enter to start it.
- Use `1` to shoot the Dealer, `2` to shoot yourself, and `3` to open your inventory.
- Select an item by its number. Enter `0` to return from the inventory.
- In Double or Nothing, choose `1` to double down or `2` to cash out.
- Press `R` after a run to restart.

On touch devices, use the on-screen keypad. The terminal output scrolls internally on mobile.

## Implemented rules

- **Story Mode:** three stages, scripted first-stage magazines, stage-specific health and item pools, revival penalties after the first two stages, and the final cut-wire rule.
- **Double or Nothing:** repeatable three-stage sets, matched randomized health, 2–8-shell loads, 1–5 items per reload, timed initial payout, and optional doubling.
- **Turn rules:** a blank fired at yourself keeps your turn; shooting the Dealer ends your turn; handcuffs skip the opponent's next turn and clear on reload.
- **Items:** Magnifying Glass, Handcuffs, Beer, Cigarette Pack, Hand Saw, Adrenaline (5-second selection window), Burner Phone, Inverter, and Expired Medicine.
- **Inventory:** up to eight items per participant; unused items carry between reloads within a stage/set.

The Dealer uses a clean-room decision heuristic based only on its own inventory, shell counts, and information it has acquired. It does not inspect the hidden shell sequence.

## Tests

Run the deterministic rules-engine tests with Node.js 20 or later:

```sh
node --test
```

GitHub Actions runs the same test suite on pushes and pull requests to `main`.
