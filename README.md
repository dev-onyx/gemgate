# Gemgate

OpenAI-compatible API server powered by Gemini via Google AI Studio.

```
gemgate/
├── server.js         # Relay server
├── models.js         # Model catalog
├── package.json
├── processor/        # AI Studio app source
│   └── index.tsx
├── README.md
└── LICENSE
```

## How it works

```
Client (OpenAI SDK) → Gemgate → WebSocket → AI Studio Processor → Gemini API
```

The server speaks the OpenAI API. An ngrok tunnel makes it publicly reachable. The [processor](https://ai.studio/apps/4bf06673-9b53-4f03-9002-3822741dcd88?fullscreenApplet=true) runs as a hosted app in AI Studio and handles the Gemini API calls.

## Quick start

### 1. Start the server

```bash
npx gemgate
```

### 2. Open the processor

**https://ai.studio/apps/4bf06673-9b53-4f03-9002-3822741dcd88?fullscreenApplet=true**

Enter the **WebSocket URL** and **Processor Token** from the server console.

### 3. Use it

Point any OpenAI-compatible client at the **API Endpoint** with the **API Key** from the console.

```bash
curl https://your-tunnel.ngrok-free.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash-latest","messages":[{"role":"user","content":"Hello"}]}'
```

## CLI

```
gemgate [options]

Options:
  --port <n>      Port (default: 3777)
  --no-tunnel     Skip ngrok, localhost only
  --help          Show help
```

## Environment

Create a `.env` file or set env vars:

| Variable | Description |
|----------|-------------|
| `GEMGATE_KEY` | Fixed API key (auto-generated if unset) |
| `GEMGATE_PROC` | Fixed processor token (auto-generated if unset) |
| `NGROK_AUTHTOKEN` | ngrok auth token |
| `PORT` | Port number |
| `REQUEST_TIMEOUT` | Timeout in ms (default: 120000) |

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/chat/completions` | Yes | Chat completions (streaming + sync) |
| `POST` | `/v1/embeddings` | Yes | Text embeddings |
| `GET` | `/v1/models` | Yes | List models |
| `GET` | `/health` | No | Health check |

## Supported

- Chat completions (streaming + sync)
- Function/tool calling
- System instructions
- Temperature, top_p, stop sequences
- JSON mode and structured output
- Reasoning effort control
- Embeddings
- Multi-modal input (images, audio)

## Requirements

- Node.js 18+
- [ngrok](https://ngrok.com) free account (or `--no-tunnel` for localhost)

## License

MIT
