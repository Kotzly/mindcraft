# Running Andy-4.2-Air on the LM Studio server

The `AndyAirLMS` bot (`profiles/andy42air-lmstudio-haiku.json`) talks to an LM Studio server on **port 7765**,
using a model loaded with the identifier **`andy-4.2-air`**. Haiku (claude-cli) writes its code, and the bot has
vision turned on (see [Vision](#vision)).

LM Studio is installed in `~/.local/opt/lmstudio/app` (menu entry "LM Studio"), and its CLI `lms` is linked in `~/.local/bin`.

## 1. Free memory first

Andy-4.2-Air Q6_K needs about 3.5 GB of VRAM, plus about 0.7 GB for the vision projector, plus context. RAM is tight on this machine.

- Don't load the same model in Ollama and LM Studio at the same time. Each one loads its own copy on the GPU.
- Unload the Ollama chat models: `ollama ps`, then `ollama stop <name>` for each chat model.
  Keep `embeddinggemma`, since the profile still uses Ollama for embeddings.
- Close the bot viewer tabs (`0.0.0.0:3000`, `3001`, ...) if RAM is low.

## 2. Start LM Studio

Pick one:

- **With the app:** open "LM Studio" from the menu. Its first launch also creates `~/.lmstudio`.
- **Headless, no window:**
  ```bash
  lms daemon up
  ```

## 3. Get the model files (once)

The bot needs two files in the same folder: the model and its vision projector (`mmproj`).

### Option A: reuse Ollama's download (no extra disk space)

If the model was already pulled with `ollama pull hf.co/Mindcraft-CE/Andy-4.2-Air-GGUF:Q6_K`, Ollama already has both files.
Ollama stores the unchanged Hugging Face files, named by their SHA-256 hash.
Hard-link them into LM Studio's models folder under their real names:

```bash
D=~/.lmstudio/models/Mindcraft-CE/Andy-4.2-Air-GGUF
B=~/.ollama/models/blobs
mkdir -p $D
ln $B/sha256-01d6a6d59c49eb7283d96ba7b0be168a3aeb42653745bcc57d361bb5b7e9a1db $D/andy-4.2-air.q6_k.gguf   # model (Q6_K)
ln $B/sha256-e53e50a64e11d8ccb308fa2cbdb38fbf14286f399e57468e3cfc06f2884a4dfd $D/mmproj-BF16.gguf         # vision projector
```

- **Open LM Studio first:** start it at least once (step 2), so `~/.lmstudio` exists.
- **Folder layout:** LM Studio pairs the projector with the model only when it sits in the same folder and its name starts with `mmproj`.
- **Why hard links:** they take no extra disk space, and they keep working if the model is removed from Ollama (`ollama rm`).
  The space is freed only when both copies are deleted. Symbolic links would break instead.
- **Same filesystem required:** hard links only work within one filesystem, and `~/.ollama` and `~/.lmstudio` are both on `/` here.
- **Where the hashes come from:** Ollama's manifest `~/.ollama/models/manifests/hf.co/Mindcraft-CE/Andy-4.2-Air-GGUF/Q6_K`.
  They match the SHA-256 Hugging Face lists for `andy-4.2-air.q6_k.gguf` and `mmproj-BF16.gguf`.

### Option B: download with LM Studio

```bash
lms get https://huggingface.co/Mindcraft-CE/Andy-4.2-Air-GGUF --select
```

Pick **Q6_K** (3.2 GB). You can also download it in the app: Discover, search `Mindcraft-CE/Andy-4.2-Air-GGUF`, pick Q6_K.

### Check

```bash
lms ls --llm
lms ls --llm --json | grep -o '"vision":[a-z]*'    # should print "vision":true
```

With the files from Option A, the model key is `andy-4.2-air` and `lms ls` shows 4.14 GB (model plus projector).
If `vision` is `false`, the `mmproj` file is missing or not in the model's folder.

## 4. Load it with the identifier the profile expects

```bash
lms load andy-4.2-air --identifier andy-4.2-air --context-length 16384 --gpu max -y
```

The first `andy-4.2-air` is the model key from `lms ls`. If you downloaded with Option B, use the key it shows.

- `--identifier andy-4.2-air`: the name the bot sends in API requests. It must match `"model"` in the profile.
- `--context-length 16384`: the model thinks before answering, and Mindcraft prompts are about 4k tokens,
  so LM Studio's small default context isn't enough.
- `--gpu max`: puts the whole model on the GPU.

To check memory before loading, add `--estimate-only`. To confirm it's loaded, run `lms ps`.

## 5. Start the server on port 7765

```bash
lms server start --port 7765 --bind 0.0.0.0
```

The server binds to `localhost` by default. But now it runs on the network.

To check it's running:

```bash
lms server status
curl http://0.0.0.0:7765/v1/models    # should list "andy-4.2-air"
```

## 6. Run the bot

In `settings.js`, uncomment:

```js
"./profiles/andy42air-lmstudio-haiku.json",
```

Then start it with `node main.js`, and talk to it with `/msg AndyAirLMS ...` in Minecraft or from the dashboard at `0.0.0.0:8080`.

## Vision

`allow_vision` is a global setting in `settings.js`, but a profile can override global settings for its own bot through a
`"settings"` object (handled in `createAgent`, `src/mindcraft/mindcraft.js`). The LM Studio profile uses that:

```json
"settings": {"allow_vision": true}
```

So only `AndyAirLMS` gets vision. The other bots keep the global `allow_vision: false`, which matters because
claude-cli doesn't support images and Andy micro isn't a vision model.

With vision on, the bot can use `!lookAtPlayer` and `!lookAtPosition`.
It renders a screenshot (saved in `bots/AndyAirLMS/screenshots/`) and sends it to the same LM Studio model.
The `image_analysis` prompt comes from the default profile. Each screenshot is rendered inside the bot process (headless WebGL) and then analyzed by the model, so looking around is slower than other commands.

To turn vision off for this bot only, set `"allow_vision": false` in the profile's `"settings"`, or remove the `"settings"` object.

## Changing the port

The port lives only in the profile's `"url"` field (`http://0.0.0.0:7765/v1`). To use another port, change both:

- the `--port` in `lms server start`
- `"url"` in `profiles/andy42air-lmstudio-haiku.json`

Keep the `/v1` suffix.

## Stopping

```bash
lms unload andy-4.2-air
lms server stop
lms daemon down      # only if you started it headless
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `My brain disconnected, try again.` in chat, connection refused in the terminal | Server not running, or not on 7765 (`lms server status`) |
| Model not found error | Loaded without `--identifier andy-4.2-air` (check `lms ps`) |
| `Context length exceeded, trying again with shorter context.` repeating | Context too small, reload with `--context-length 16384` |
| Very slow replies, system swapping | Model partly in RAM, or Ollama still holding a copy (`ollama ps`, `lms ps`) |
| Loops or strange formatting | Sampling settings in the profile `"params"` (authors' values: temp 0.6, top_k 20, top_p 0.95, repeat_penalty 1.0) |
| `Vision is disabled. Use other methods to describe the environment.` | The profile's `"settings": {"allow_vision": true}` is missing, or the bot was started before it was added |
| Image errors from LM Studio, or answers that ignore the image | Projector not loaded: check `"vision":true` in `lms ls --llm --json`, then reload the model |
