# Messaging

BellaClaw supports Discord DMs and Signal direct messages. Conversation history, settings, and
scheduled deliveries are scoped by platform and chat.

At least one transport is needed to talk to BellaClaw.

## Discord

Discord is the easiest option and the default quick-start transport.

### Set Up

1. Create an application in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **Bot**, create or reset the token, and enable **Message Content Intent**.
3. Open **Installation**, enable **User Install**, and install the app on your Discord account.
4. Put the token in `.env`:

   ```dotenv
   DISCORD_TOKEN=your-bot-token
   ```

5. Start BellaClaw and open a DM with the installed app.

BellaClaw ignores server messages and empty messages. Discord is disabled when `DISCORD_TOKEN` is
missing or blank.

Never commit or share the bot token.

## Signal

Signal uses
[`bbernhard/signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api) as a linked
secondary device.

### Link With Podman

Start BellaClaw and the Signal sidecar:

```bash
podman compose --profile signal up -d --build
```

Open:

```text
http://127.0.0.1:8080/v1/qrcodelink?device_name=bellaclaw
```

Scan the QR code in Signal:

**Settings → Linked devices → Link new device**

Check that the sidecar lists the account:

```text
http://127.0.0.1:8080/v1/accounts
```

Update `.env`:

```dotenv
SIGNAL_ENABLED=true
SIGNAL_PHONE_NUMBER=+48123456789
```

Compose already sets `SIGNAL_CLI_RPC_URL=http://signal-cli:8080`.

Recreate the services:

```bash
podman compose --profile signal up -d --build
```

Keep the `signal-cli-data` volume. Deleting it removes the linked-device session and requires
linking again.

### Run the Signal API Locally

For host development without Compose:

```bash
podman run -d \
  --name bellaclaw-signal-cli \
  -e MODE=json-rpc \
  -p 127.0.0.1:8080:8080 \
  -v "${SIGNAL_CLI_DATA_DIR:-./signal-cli-data}:/home/.local/share/signal-cli" \
  bbernhard/signal-cli-rest-api:0.100-rootless
```

Set:

```dotenv
SIGNAL_ENABLED=true
SIGNAL_PHONE_NUMBER=+48123456789
SIGNAL_CLI_RPC_URL=http://127.0.0.1:8080
```

Do not expose the Signal API publicly.
