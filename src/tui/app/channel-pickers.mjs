/**
 * channel-pickers.mjs — the Channel setup picker cluster.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory. Every function body is the original App logic verbatim, with closure
 * identifiers threaded through the factory argument. Cross-references between
 * the three openers stay inside this factory; the onboarding-only dep
 * (onboardingWarnReopen) threads as a lazy getter wrapper so it resolves the
 * live opener at call time.
 */
import { theme } from '../theme.mjs';
import { isVoiceEnabled, toggleVoice, isVoiceInstallBusy } from '../lib/voice-setup.mjs';

export function createChannelPickers({
  store,
  setPicker,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  setContextPanel,
  onboardingWarnReopen,
}) {
  // Bumped whenever any picker in this cluster is (re)rendered or the root is
  // cancelled. applyVoice() captures it before an async toggleVoice() install
  // and only reopens the root if it is UNCHANGED when the promise resolves —
  // a long first-time install finishing later must not hijack whatever
  // screen/picker the user has since navigated to.
  let pickerGen = 0;
  const openChannelTypeActionsPicker = async (backend, options = {}) => {
    pickerGen += 1;
    const parentReturn = typeof options.returnTo === 'function'
      ? options.returnTo
      : () => openChannelSettingTypePicker();
    setProviderPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    let setup;
    try {
      setup = await store.getChannelSetup();
    } catch (e) {
      store.pushNotice(`channels failed: ${e?.message || e}`, 'error');
      return;
    }
    const isTelegram = backend === 'telegram';
    const activeBackend = setup.backend || 'discord';
    const tokenDescription = isTelegram
      ? `${setup.telegram?.status ?? 'Off'}${setup.telegram?.problem ? ' · Invalid' : ''}`
      : `${setup.discord.status}${setup.discord.problem ? ' · Invalid' : ''}`;
    const mainEntry = setup.channel || {};
    const mainTarget = isTelegram
      ? (mainEntry?.telegramChatId || (activeBackend === 'telegram' ? mainEntry?.channelId : ''))
      : (mainEntry?.discordChannelId || (activeBackend === 'discord' ? mainEntry?.channelId : ''));
    const mainDescription = isTelegram
      ? (mainTarget ? `Chat ID ${mainTarget}` : 'Not set · Enter Telegram chat ID')
      : (mainTarget ? `Channel ID ${mainTarget}` : 'Not set · Enter Discord channel ID');

    const openChannelPrompt = (prompt) => {
      setPicker(null);
      setContextPanel(null);
      setChannelPrompt({
        ...prompt,
        afterSave: () => openChannelTypeActionsPicker(backend, options),
      });
    };

    setPicker({
      title: isTelegram ? 'Telegram' : 'Discord',
      description: activeBackend === backend
        ? 'Active channel type · token and main target'
        : 'Token and main target settings',
      help: '↑/↓ Select · Enter Edit · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      items: [
        {
          value: 'token',
          label: 'Bot token',
          description: tokenDescription,
          _action: isTelegram ? 'telegram-token' : 'discord-token',
        },
        {
          value: 'main',
          label: isTelegram ? 'Main chat' : 'Main channel',
          description: mainDescription,
          _action: 'main-target',
        },
      ],
      onSelect: (_value, item) => {
        try {
          if (item._action === 'discord-token') {
            openChannelPrompt({
              kind: 'discord-token',
              label: 'Discord bot token',
              hint: 'Paste the Discord bot token. It is stored in the OS keychain.',
            });
            return;
          }
          if (item._action === 'telegram-token') {
            openChannelPrompt({
              kind: 'telegram-token',
              label: 'Telegram bot token',
              hint: 'Paste the Telegram bot token from @BotFather. Stored in the OS keychain.',
            });
            return;
          }
          if (item._action === 'main-target') {
            openChannelPrompt({
              kind: 'channel-add',
              backend,
              label: isTelegram ? 'Main chat' : 'Main channel',
              hint: isTelegram
                ? 'Paste the Telegram chat ID.'
                : 'Paste the Discord channel ID.',
            });
          }
        } catch (e) {
          store.pushNotice(`channels update failed: ${e?.message || e}`, 'error');
        }
      },
      onCancel: () => {
        parentReturn();
      },
    });
  };

  const openChannelSettingTypePicker = async (options = {}) => {
    pickerGen += 1;
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : () => {};
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    let setup;
    try {
      setup = await store.getChannelSetup();
    } catch (e) {
      store.pushNotice(`channels failed: ${e?.message || e}`, 'error');
      return;
    }
    const activeBackend = setup.backend || 'discord';
    const mainEntry = setup.channel || {};
    const typeDescription = (backend) => {
      const selected = activeBackend === backend;
      const hasToken = backend === 'telegram'
        ? setup.telegram?.authenticated === true
        : setup.discord?.authenticated === true;
      const hasTarget = backend === 'telegram'
        ? Boolean(mainEntry?.telegramChatId || (activeBackend === 'telegram' && mainEntry?.channelId))
        : Boolean(mainEntry?.discordChannelId || (activeBackend === 'discord' && mainEntry?.channelId));
      const needs = [
        ...(hasToken ? [] : ['token']),
        ...(hasTarget ? [] : [backend === 'telegram' ? 'chat ID' : 'channel ID']),
      ];
      return [
        ...(selected ? ['Selected'] : []),
        needs.length ? `Needs ${needs.join(' + ')}` : 'Ready',
      ].join(' · ');
    };
    setPicker({
      title: 'Channel Type Settings',
      description: 'Choose a type. Selected is the active backend; Ready means token and main target are set.',
      help: '↑/↓ Select · Enter Open · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      items: [
        {
          value: 'discord',
          label: 'Discord',
          description: typeDescription('discord'),
          _backend: 'discord',
        },
        {
          value: 'telegram',
          label: 'Telegram',
          description: typeDescription('telegram'),
          _backend: 'telegram',
        },
      ],
      onSelect: (value, item) => {
        const backend = item?._backend || (value === 'telegram' ? 'telegram' : value === 'discord' ? 'discord' : null);
        if (!backend) return;
        setPicker(null);
        openChannelTypeActionsPicker(backend, {
          returnTo: () => openChannelSettingTypePicker(options),
        });
      },
      onCancel: () => {
        setPicker(null);
        returnTo();
      },
    });
  };

  const openChannelSetupPicker = async (focus = 'all', options = {}) => {
    pickerGen += 1;
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    let setup;
    try {
      setup = await store.getChannelSetup();
    } catch (e) {
      store.pushNotice(`channels failed: ${e?.message || e}`, 'error');
      return;
    }

    const openChannelPrompt = (prompt) => {
      setPicker(null);
      setContextPanel(null);
      setChannelPrompt(prompt);
    };

    // Schedules/webhooks management is desktop-only (user decision): the TUI
    // no longer carries their pickers or the webhook-endpoint info page.
    const worker = store.getChannelWorkerStatus?.();
    const activeBackend = setup.backend === 'telegram' ? 'telegram' : 'discord';
    const backendLabel = activeBackend === 'telegram' ? 'Telegram' : 'Discord';
    const remoteEnabled = store.isRemoteEnabled?.() === true;
    const boolLabel = (enabled) => enabled ? 'On' : 'Off';
    // Onboarding Step 5 reuses this root picker with a ConfirmBar. Reopens after
    // a toggle must carry the onboarding context (confirmBar + flag) forward so
    // Back/Finish stay wired and the general /channels path keeps its own opts.
    const reopenRoot = (extra = {}) => {
      const preserved = options.onboarding
        ? { onboarding: true, confirmBar: options.confirmBar || null }
        : {};
      void openChannelSetupPicker('all', { ...preserved, ...extra });
    };
    const applyRemoteRuntime = (highlightValue = 'remote-runtime') => {
      const enabled = store.toggleRemote?.() === true;
      store.pushNotice(enabled ? 'Remote mode ON' : 'Remote mode OFF', 'info');
      reopenRoot({ highlightValue });
    };
    const cycleChannelBackend = (direction = 1, highlightValue = 'channel-backend') => {
      const backends = ['discord', 'telegram'];
      const currentIndex = Math.max(0, backends.indexOf(activeBackend));
      const chosen = backends[(currentIndex + direction + backends.length) % backends.length];
      if (chosen === activeBackend) {
        reopenRoot({ highlightValue, backendOverride: activeBackend });
        return;
      }
      try {
        store.setBackend(chosen);
        const label = chosen === 'telegram' ? 'Telegram' : 'Discord';
        const restartHint = (store.isRemoteEnabled?.() === true || worker?.running)
          ? `Channel set to ${label}. Restart remote to apply.`
          : `Channel set to ${label}.`;
        store.pushNotice(restartHint, 'info');
      } catch (e) {
        store.pushNotice(`channel backend failed: ${e?.message || e}`, 'error');
      }
      reopenRoot({ highlightValue, backendOverride: chosen });
    };
    // Voice toggle: enabling installs the managed whisper/ffmpeg runtime (first
    // time only) then flips voice.enabled so the channels pipeline transcribes
    // incoming voice messages. toggleVoice owns all notices/progress; we just
    // reopen the root once it settles so the meta/description reflect the new
    // state. Guard against a double-trigger while an install is in flight.
    const applyVoice = (highlightValue = 'voice') => {
      if (isVoiceInstallBusy()) {
        store.pushNotice('Voice install is already running', 'warn');
        return;
      }
      const gen = pickerGen;
      void Promise.resolve(toggleVoice({ pushNotice: store.pushNotice, setProgressHint: store.setProgressHint }))
        .then(() => {
          // toggleVoice already pushed its own ON/OFF/failure notice. Only
          // reopen the root when it is still the active context; if the user
          // navigated away during a long install, leave their screen alone.
          if (pickerGen === gen) reopenRoot({ highlightValue });
        });
    };
    const items = [
      {
        value: 'remote-runtime',
        label: 'Remote Runtime',
        meta: boolLabel(remoteEnabled),
        description: worker?.running ? `Running · pid ${worker.pid}` : 'Stopped',
        _action: 'remote-runtime',
      },
      {
        value: 'channel-backend',
        label: 'Channel',
        meta: backendLabel,
        description: 'Select Discord or Telegram',
        _action: 'channel-backend',
      },
      {
        value: 'channel-setting',
        label: 'Setting',
        description: 'Token and main target',
        _action: 'channel-setting',
      },
      {
        value: 'voice',
        label: 'Voice',
        meta: boolLabel(isVoiceEnabled()),
        description: isVoiceEnabled()
          ? 'Channel voice messages will be transcribed'
          : 'Transcribe channel voice messages',
        _action: 'voice',
      },
      {
        value: 'webhook-endpoint',
        label: 'Webhook endpoint',
        // Relay tunnel: public exposure is automatic, so the endpoint is
        // "On" whenever the webhook server itself is enabled.
        meta: setup.webhook?.enabled === false ? 'Off' : 'On',
        description: setup.webhook?.publicUrl
          ? setup.webhook.publicUrl
          : 'Mixdog relay tunnel — URL assigned on first run',
        _action: 'webhook-endpoint',
      },
    ];

    setPicker({
      title: 'Channels',
      description: 'Remote access and channel setup.',
      // Onboarding overlays a ConfirmBar (←/→ drive Back/Finish, not toggles),
      // so drop the ←/→ Change hint there and use the Picker's ConfirmBar help.
      help: options.confirmBar ? undefined : '↑/↓ Select · ←/→ Change · Enter Choose/Toggle · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 12,
      pickerKey: `channels:${activeBackend}:${remoteEnabled ? 'on' : 'off'}:${options.highlightValue || 'root'}`,
      initialIndex: Math.max(0, items.findIndex((entry) => entry.value === options.highlightValue)),
      items,
      confirmBar: options.confirmBar || null,
      onLeft: options.confirmBar ? undefined : (item) => {
        if (item?._action === 'remote-runtime') applyRemoteRuntime(item.value);
        else if (item?._action === 'channel-backend') cycleChannelBackend(-1, item.value);
        else if (item?._action === 'voice') applyVoice(item.value);
      },
      onRight: options.confirmBar ? undefined : (item) => {
        if (item?._action === 'remote-runtime') applyRemoteRuntime(item.value);
        else if (item?._action === 'channel-backend') cycleChannelBackend(1, item.value);
        else if (item?._action === 'voice') applyVoice(item.value);
      },
      onSelect: (_value, item) => {
        try {
          if (item._action === 'remote-runtime') {
            applyRemoteRuntime(item.value);
            return;
          }
          if (item._action === 'channel-backend') {
            cycleChannelBackend(1, item.value);
            return;
          }
          if (item._action === 'voice') {
            applyVoice(item.value);
            return;
          }
          if (item._action === 'channel-setting') {
            openChannelSettingTypePicker({
              returnTo: () => reopenRoot({ highlightValue: 'channel-setting' }),
            });
            return;
          }
          if (item._action === 'webhook-endpoint') {
            void openChannelSetupPicker('webhook-endpoint', {
              ...(options.onboarding ? { onboarding: true, confirmBar: options.confirmBar || null } : {}),
              returnTo: () => reopenRoot({ highlightValue: 'webhook-endpoint' }),
            });
          }
        } catch (e) {
          store.pushNotice(`channels update failed: ${e?.message || e}`, 'error');
        }
      },
      onCancel: () => {
        setPicker(null);
        pickerGen += 1;
        // Onboarding Step 5 Esc mirrors the other steps' reopen-next-launch warning.
        if (options.onboarding) onboardingWarnReopen();
      },
    });
  };

  return {
    openChannelTypeActionsPicker,
    openChannelSettingTypePicker,
    openChannelSetupPicker,
  };
}
