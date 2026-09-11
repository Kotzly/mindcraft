# Running Andy-4.2-Air on the LM Studio server

The `AndyAirLMS` bot (`profiles/andy42air-lmstudio-haiku.json`) talks to an LM Studio server on **port 7765**,
using a model loaded with the identifier **`andy-4.2-air`**. Haiku (claude-cli) writes its code.

LM Studio is installed in `~/.local/opt/lmstudio/app` (menu entry "LM Studio"), and its CLI `lms` is linked in `~/.local/bin`.

## 1. Free memory first

Andy-4.2-Air Q6_K needs about 3.5 GB of VRAM plus context, and RAM is tight on this machine.

- Don't load the same model in Ollama and LM Studio at the same time. Each one loads its own copy on the GPU.
- Unload the Ollama chat models: `ollama ps`, then `ollama stop <name>` for each chat model.
  Keep `embeddinggemma`, since the profile still uses Ollama for embeddings.
- Close the bot viewer tabs (`localhost:3000`, `3001`, ...) if RAM is low.

## 2. Start LM Studio

Pick one:

- **With the app:** open "LM Studio" from the menu. Its first launch also creates `~/.lmstudio`.
- **Headless, no window:**
  ```bash
  lms daemon up
  ```

## 3. Download the model (once)

```bash
lms get https://huggingface.co/Mindcraft-CE/Andy-4.2-Air-GGUF --select
```

Pick **Q6_K** (3.2 GB). You can also download it in the app: Discover, search `Mindcraft-CE/Andy-4.2-Air-GGUF`, pick Q6_K.

Then find the model key LM Studio assigned to it:

```bash
lms ls --llm
```

## 4. Load it with the identifier the profile expects

```bash
lms load <model-key> --identifier andy-4.2-air --context-length 16384 --gpu max -y
```

- `--identifier andy-4.2-air`: the name the bot sends in API requests. It must match `"model"` in the profile.
- `--context-length 16384`: the model thinks before answering, and Mindcraft prompts are about 4k tokens,
  so LM Studio's small default context isn't enough.
- `--gpu max`: puts the whole model on the GPU.

To check memory before loading, add `--estimate-only`. To confirm it's loaded, run `lms ps`.

## 5. Start the server on port 7765

```bash
lms server start --port 7765
```

The server binds to `127.0.0.1` by default, which is enough for the bot.

To check it's running:

```bash
lms server status
curl http://localhost:7765/v1/models    # should list "andy-4.2-air"
```

## 6. Run the bot

In `settings.js`, uncomment:

```js
"./profiles/andy42air-lmstudio-haiku.json",
```

Then start it with `node main.js`, and talk to it with `/msg AndyAirLMS ...` in Minecraft or from the dashboard at `localhost:8080`.

## Changing the port

The port lives only in the profile's `"url"` field (`http://localhost:7765/v1`). To use another port, change both:

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
