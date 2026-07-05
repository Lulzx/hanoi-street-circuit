# Deployment

The game is static files only (`index.html`, `main.js`, `assets/`, `tools/`) — no build step. It deploys to two targets.

## 1. GitHub Pages (automatic)

- Repo: `Lulzx/hanoi-street-circuit`, live at **https://lulzx.com/hanoi-street-circuit/** (custom domain).
- Any push to `main` auto-deploys. Nothing else to do.

## 2. VPS `lulz` (manual rsync)

Live at **https://circuit.lulzx.space/**, served by Caddy running in the `pgrok-caddy-1` docker container on the `lulz` host.

```sh
rsync -avz --delete --exclude '.DS_Store' index.html main.js assets tools lulz:/opt/pgrok/www/circuit/
```

- Host path `/opt/pgrok/www/circuit` maps to `/srv/www/circuit` inside the container.
- DNS and the Caddy site block (single Caddyfile at `/etc/caddy/Caddyfile`) already exist — **no Caddy reload needed** for file-only updates.

Verify: `curl -sI https://circuit.lulzx.space/` should return 200.

## Notes

- Renderer is WebGPU (three.js `WebGPURenderer`, pinned via the import map in `index.html`); it falls back to WebGL2 automatically. Append `?webgl` to the URL to force the WebGL2 backend for A/B testing.
- If `assets/track.glb` changes, regenerate the racing line with `tools/buildline.js` (run `import('/tools/buildline.js')` in the live page) and ship the resulting `assets/racingline.json`.
- GLBs are Draco-compressed with `gltf-transform draco`; temp output filenames must end in `.glb`.
