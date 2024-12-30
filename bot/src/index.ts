import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  ChannelType,
  MessagePayload,
  MessageCreateOptions,
  VoiceChannel,
} from "discord.js"
import {
  joinVoiceChannel,
  VoiceReceiver,
  EndBehaviorType,
  createAudioResource,
  StreamType,
  createAudioPlayer,
  DiscordGatewayAdapterCreator,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} from "@discordjs/voice"
import { generateDependencyReport } from "@discordjs/voice"
import NodeCache from "node-cache"

import { logger } from "./logger/index.js"

import { Readable } from "stream"
import { EventEmitter } from "events"
import WebSocket from "ws"

logger.debug(generateDependencyReport())

// Add new types for our audio events
interface AudioData {
  userId: string
  audioBuffer: Buffer
}

// Modify the emitter to be typed
export const emitter = new EventEmitter()

// Remove WebRTC/UDP specific code and add WebSocket configuration
const WS_URL = "ws://localhost:8080?type=bot"

// Replace previous connection code with WebSocket listener
function connectToWebSocket() {
  logger.debug("connecting to websocket")
  const ws = new WebSocket(WS_URL)

  ws.on("open", () => {
    logger.info("WebSocket connection established")
  })

  ws.on("message", (data) => {
    // Assuming the incoming audio is already in Opus format
    const audioData = Buffer.from(data as ArrayBuffer)
    // logger.debug({ dataLength: audioData.length }, "got audio data")
    emitter.emit("audio", {
      userId: "websocket-audio",
      audioBuffer: audioData,
    })
  })

  ws.on("error", (error) => {
    logger.error({ error }, "WebSocket connection error")
  })

  ws.on("close", () => {
    logger.info("WebSocket connection closed")
    // Attempt to reconnect after a delay
    setTimeout(() => {
      logger.info("Attempting to reconnect...")
      connectToWebSocket()
    }, 5000)
  })
}

// Start WebSocket connection
connectToWebSocket()

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
})

const audioPlayer = createAudioPlayer({
  behaviors: {
    maxMissedFrames: 1000,
    noSubscriber: NoSubscriberBehavior.Play,
  },
})

const commands: {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder
  handler(interaction: ChatInputCommandInteraction): Promise<void>
}[] = [
  {
    data: new SlashCommandBuilder()
      .setName("join-voice-channel")
      .setDescription("Join a voice channel")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("The channel to join")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildVoice)
      ),
    async handler(interaction) {
      const channel = interaction.options.getChannel("channel", true)
      logger.debug(`got join-voice-channel for channel: ${channel.id}`)

      if (
        channel.type !== ChannelType.GuildVoice ||
        !(channel instanceof VoiceChannel)
      ) {
        await interaction.reply({
          content: "ERROR: can only set this to a voice channel!",
          ephemeral: true,
        })
        return
      }

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: interaction.guildId!,
        adapterCreator: channel.guild
          .voiceAdapterCreator as DiscordGatewayAdapterCreator,
        debug: true,
        selfDeaf: false,
        selfMute: false,
      })

      connection.on("stateChange", (oldState, newState) => {
        logger.info(
          `Connection transitioned from ${oldState.status} to ${newState.status}`
        )
      })

      audioPlayer.on("stateChange", (oldState, newState) => {
        logger.info(
          `Audio player transitioned from ${oldState.status} to ${newState.status}`
        )
      })

      // Create a new audio stream that properly handles Opus packets
      let audioQueue: Buffer[] = []

      const audioStream = new Readable({
        read(size) {
          // console.log("read", size)
          // if (audioQueue.length > 0) {
          //   logger.debug("sending audio data")
          //   const chunk = audioQueue.shift()
          //   return chunk
          // }
          // logger.debug("no audio data")
          return null
        },
      })

      // Set up the audio event listener before creating the resource
      emitter.on("audio", (audioData: AudioData) => {
        // logger.debug(
        //   { audioDataLength: audioData.audioBuffer.length },
        //   "got audio data"
        // )
        // audioQueue.push(audioData.audioBuffer)
        audioStream.emit("data", audioData.audioBuffer)
      })

      const resource = createAudioResource(audioStream, {
        inputType: StreamType.WebmOpus,
      })

      // const resource = createAudioResource(
      //   "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
      //   {
      //     inputType: StreamType.Arbitrary,
      //   }
      // )

      // Handle any errors
      audioPlayer.on("error", (error) => {
        console.error(error)
        logger.error("Error in audio player")
      })

      connection.on("error", (error) => {
        console.error(error)
        logger.error("Error in connection")
      })

      // First subscribe the connection to the player
      connection.subscribe(audioPlayer)

      // Only start playing once the connection is ready
      connection.on(VoiceConnectionStatus.Ready, () => {
        logger.debug("Connection is ready, starting playback")
        try {
          audioPlayer.play(resource)
        } catch (error) {
          console.error(error)
          logger.error("Error playing audio")
        }
      })

      await interaction.reply({
        content: `Joined voice channel ${channel}! Now listening for audio.`,
        ephemeral: true,
      })
    },
  },
]

client.on(Events.InteractionCreate, (interaction) => {
  if (interaction instanceof ChatInputCommandInteraction) {
    logger.debug(`got interaction: ${interaction.commandName}`)
    commands
      .find((cmd) => cmd.data.name === interaction.commandName)
      ?.handler(interaction)
  }
})

client.once("ready", async () => {
  logger.info("Discord bot is ready")

  // Log all guilds the bot is in
  const guilds = client.guilds.cache.map(
    (guild) => `${guild.name} (${guild.id})`
  )
  logger.debug({ guilds }, "Bot is in guilds:")

  // Register Commands
  const res = new REST().setToken(process.env.DISCORD_BOT_TOKEN!)
  await res.put(Routes.applicationCommands(process.env.DISCORD_APP_ID!), {
    body: commands.map((d) => d.data.toJSON()),
  })
})

// When we join a server, we need to check our permissions
client.on("guildCreate", async (guild) => {
  const botMember = await guild.members.fetch(client.user!.id)
  logger.info({ botMember }, "Bot member details:")

  logger.info(`Bot joined guild: ${guild.name} (${guild.id})`)
  logger.info("Permissions granted:", {
    permissions: botMember?.permissions.toArray(),
  })

  // Optional: Check for specific required permissions
  const requiredPermissions = [
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.SendMessagesInThreads,
    PermissionsBitField.Flags.Connect,
    PermissionsBitField.Flags.Speak,
  ]

  const missingPermissions = requiredPermissions.filter(
    (perm) => !botMember?.permissions.has(perm)
  )

  if (missingPermissions.length > 0) {
    logger.warn("Missing required permissions:", {
      missing: missingPermissions,
    })
  }
})

// When we are removed from a server
client.on("guildDelete", (guild) => {
  logger.info(`Bot was removed from guild: ${guild.name} (${guild.id})`)
})

await client.login(process.env.DISCORD_BOT_TOKEN!)
