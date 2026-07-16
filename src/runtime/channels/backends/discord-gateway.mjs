// Gateway connect / login / event-listener wiring extracted from discord.mjs.
// Implemented as instance-method installers that operate on a DiscordBackend
// `self`. Behavior is byte-identical to the originals; only the host object is
// passed explicitly instead of via `this`.

async function connect(self) {
  // Re-entry guard: if a connect() is already in-flight or completed, return
  // the same promise / no-op so concurrent ownership-timer fires cannot
  // overwrite self.client, duplicate listeners, or trigger duplicate logins.
  if (self._connectPromise) return self._connectPromise;
  self._connectPromise = connectInner(self).catch((err) => {
    self._connectPromise = null;
    throw err;
  });
  return self._connectPromise;
}

async function connectInner(self) {
  await buildClient(self);
  applyStaticAccessOverride(self);
  registerEventListeners(self);
  registerSlashCommands(self);
  registerShardListeners(self);
  try {
    await awaitLogin(self);
  } catch (err) {
    // Destroy the partial Client to free the listeners/handles it already
    // attached. Without this, a ready-timeout retry leaks every listener
    // set by registerEventListeners/registerSlashCommands/registerShardListeners.
    try { self.client?.destroy?.(); } catch {}
    self.client = null;
    throw err;
  }
  await self.persistAccessFromMainChannel();
}

async function buildClient(self) {
  const { Client, GatewayIntentBits, Partials } = await self._ensureDiscord();
  self.client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });
}

function applyStaticAccessOverride(self) {
  if (self.isStatic) {
    self.bootAccess = self.loadAccess();
  }
}

function registerEventListeners(self) {
  self.client.on("error", (err) => {
    process.stderr.write(`mixdog discord: client error: ${err}
`);
  });
  self.client.on("messageCreate", (msg) => {
    if (msg.author.id === self.client.user?.id) {
      return;
    }
    if (msg.author.bot) return;
    self.handleInbound(msg, Date.now()).catch(
      (e) => process.stderr.write(`mixdog discord: handleInbound failed: ${e}
`)
    );
  });
  self.client.on("interactionCreate", async (interaction) => {
    try {
      // Trust gate for interactions. Buttons / selects / modal submits used to
      // reach onInteraction / onModalRequest without passing through the
      // message gate(), so a configured allowFrom never applied to them
      // (schedule/quiet/profile modals + perm approvals were openable by any
      // user in the channel). Apply the same allowFrom decision here; an empty
      // allowFrom stays open so current configs are unaffected.
      if (!self._interactionAllowed(interaction.channelId ?? "", interaction.user?.id, interaction)) {
        try {
          if (typeof interaction.reply === "function" && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "⛔ Not authorized for this action.", ephemeral: true });
          } else if (typeof interaction.deferUpdate === "function") {
            await interaction.deferUpdate();
          }
        } catch {}
        return;
      }
      if (interaction.isChatInputCommand() && interaction.commandName === "stop") {
        await interaction.reply({ content: "\u23F9 Stopping...", ephemeral: true });
        if (self.onInteraction) {
          self.onInteraction({
            type: "button",
            customId: "stop_task",
            userId: interaction.user.id,
            channelId: interaction.channelId ?? ""
          });
        }
        return;
      }
      if (interaction.isModalSubmit()) {
        if (self.onInteraction) {
          const fields = {};
          for (const row of interaction.components) {
            for (const comp of row.components ?? []) {
              if (comp.customId && comp.value != null) fields[comp.customId] = String(comp.value);
            }
          }
          self.onInteraction({
            type: "modal",
            customId: interaction.customId,
            userId: interaction.user.id,
            channelId: interaction.channelId ?? "",
            fields,
            message: interaction.message ? { id: interaction.message.id } : void 0
          });
        }
        await interaction.deferUpdate().catch(() => {
        });
        return;
      }
      if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu() || interaction.isChannelSelectMenu()) {
        const needsModal = interaction.isButton() && (interaction.customId === "sched_add_next" || interaction.customId === "sched_edit_next" || interaction.customId === "profile_edit");
        if (needsModal) {
          if (self.onModalRequest) {
            await Promise.resolve(self.onModalRequest(interaction)).catch((err) => {
              process.stderr.write(`mixdog discord: onModalRequest failed: ${err}\n`);
            });
          }
          return;
        }
        await interaction.deferUpdate().catch(() => {
        });
        if (self.onInteraction) {
          self.onInteraction({
            type: interaction.isButton() ? "button" : "select",
            customId: interaction.customId,
            userId: interaction.user.id,
            channelId: interaction.channelId,
            values: interaction.isStringSelectMenu() ? interaction.values : void 0,
            message: interaction.message ? { id: interaction.message.id } : void 0
          });
        }
      }
    } catch (err) {
      process.stderr.write(`mixdog discord: interaction error: ${err}
`);
    }
  });
}

function registerSlashCommands(self) {
  self.client.on(self._discordEvents().ClientReady, async (c) => {
    process.stderr.write(`mixdog discord: gateway connected as ${c.user.tag}
`);
    try {
      // Plugin registers no global commands; clear the global slot so any
      // pre-existing entry from prior installs is not surfaced to users.
      await c.application?.commands.set([]);
      process.stderr.write(`mixdog discord: global application commands cleared
`);

      // Replace each guild's command set with just /stop. set() overwrites,
      // so the desired set is the only one that survives.
      const desiredCommands = [
        { name: "stop", description: "Stop the current Mixdog response" },
      ];
      for (const [guildId] of c.guilds.cache) {
        await c.application?.commands.set(desiredCommands, guildId);
      }
      // Register /stop globally so it is available in DM bridge contexts
      // where there is no guild scope.
      try {
        await c.application?.commands.set(desiredCommands);
      } catch (e) {
        process.stderr.write(`mixdog discord: global /stop register failed: ${e?.message}\n`);
      }
      process.stderr.write(`mixdog discord: /stop command registered (${c.guilds.cache.size} guild(s))
`);
    } catch (err) {
      process.stderr.write(`mixdog discord: slash command registration failed: ${err}
`);
    }
  });
}

function registerShardListeners(self) {
  self.client.on("shardDisconnect", (ev, id) => {
    process.stderr.write(`mixdog discord: shard ${id} disconnected (code ${ev.code}). Will auto-reconnect.
`);
  });
  self.client.on("shardReconnecting", (id) => {
    process.stderr.write(`mixdog discord: shard ${id} reconnecting...
`);
  });
  self.client.on("shardResume", (id, replayedEvents) => {
    process.stderr.write(`mixdog discord: shard ${id} resumed (replayed ${replayedEvents} events)
`);
  });
  self.client.on("warn", (msg) => {
    process.stderr.write(`mixdog discord: warn: ${msg}
`);
  });
}

async function awaitLogin(self) {
  let readyTimeout;
  // Adaptive ready timeout: grow on consecutive login failures (30s→60s→90s
  // cap) so an identify delayed by gateway rate-limiting can still complete
  // its READY handshake instead of tripping a fixed 30s timeout every retry.
  const readyMs = Math.min(90_000, 30_000 + (self._loginFailures || 0) * 30_000);
  const readyPromise = new Promise((resolve, reject) => {
    readyTimeout = setTimeout(
      () => reject(new Error(`discord ready timeout (${Math.round(readyMs / 1000)}s)`)),
      readyMs
    );
    self.client.once(self._discordEvents().ClientReady, () => {
      clearTimeout(readyTimeout);
      resolve();
    });
  });
  // Guarantee the ready-timeout rejection can never surface as a process-global
  // unhandledRejection regardless of how the race below settles: attach an
  // absorbing handler; the real handling still happens via the awaits.
  readyPromise.catch(() => {});
  // Observe the ready timer from the start: login() can hang past the 30s
  // timer (gateway reconnect), and a rejection on an un-awaited readyPromise
  // becomes a process-global unhandledRejection → fatal crash path
  // (channels/index.mjs unhandledRejection → _fatalCrash → exit(1)). Racing
  // login with readyPromise keeps the rejection inside this connect() chain,
  // which every caller already catches non-fatally.
  const loginPromise = self.client.login(self.token);
  // A late login settlement after the timeout raced ahead must not itself
  // become a second unhandled rejection.
  loginPromise.catch(() => {});
  try {
    await Promise.race([loginPromise, readyPromise]);
    await readyPromise;
    self._loginFailures = 0;
  } catch (err) {
    self._loginFailures = (self._loginFailures || 0) + 1;
    clearTimeout(readyTimeout);
    throw err;
  }
}

export {
  connect,
  connectInner,
  buildClient,
  applyStaticAccessOverride,
  registerEventListeners,
  registerSlashCommands,
  registerShardListeners,
  awaitLogin
};
