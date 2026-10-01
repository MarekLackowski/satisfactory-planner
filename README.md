# Satisfactory Factory Planner

**Live:** https://mareklackowski.github.io/satisfactory-planner/

Production calculator for Satisfactory 1.x. Pick your unlocked alternate recipes, buildings and belt tiers, set inputs (resource rates or miners on impure/normal/pure nodes) and the outputs you want — or maximize them. A linear-programming solver (HiGHS) finds the optimal recipe mix; the factory is laid out as a graph with manifolds, parallel belts and belt tiers, and the item flow is animated live.

If you find it useful: [☕ buy me a coffee](https://ko-fi.com/mareklackowski)

## Development

```
start.bat          # Windows: install if needed, start and open the browser
npm install
npm run dev        # http://localhost:5173
npm run check      # solver/plan/layout self-check
npm run build      # production build (GitHub Pages base path)
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.

Game data comes from the game install: `npm run data -- "<Satisfactory>/CommunityResources/Docs/en-US.json"` regenerates `src/data/game.json`.
Icons: `npm run icons` downloads them from satisfactory.wiki.gg into `public/icons` and shrinks them to 96 px.

---

Not affiliated with Coffee Stain Studios. Game assets © Coffee Stain Studios. Icons courtesy of [satisfactory.wiki.gg](https://satisfactory.wiki.gg).
