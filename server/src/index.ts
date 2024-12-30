import express from "express"
import { v4 as uuidv4 } from "uuid"
import cors from "cors"
import { ZodError } from "zod"
import { logger } from "./logger/index.js"
import { extractError } from "./utils.js"
import { WebSocketServer, WebSocket } from "ws"

const listenPort = process.env.PORT || "8080"

declare global {
  namespace Express {
    interface Request {
      id: string
    }
  }

  namespace NodeJS {
    interface ProcessEnv {
      DB_FILENAME?: string
      ADMIN_EMAILS?: string
      AWS_DEFAULT_REGION?: string
      AWS_ACCESS_KEY_ID?: string
      AWS_SECRET_ACCESS_KEY?: string
      S3_BUCKET: string
      S3_ENDPOINT: string
      POSTMARK_TOKEN: string
      MY_URL: string

      AXIOM_ORG_ID: string
      AXIOM_TOKEN: string
      AXIOM_DATASET: string
    }
  }
}

process.on("unhandledRejection", (reason: any, p: Promise<any>) => {
  logger.error(
    {
      err: reason instanceof Error ? extractError(reason) : reason,
    },
    "unhandled promise rejection"
  )
})

// Track all connected bot clients
const botClients = new Set<WebSocket>()
// Track web clients (audio sources)
const webClients = new Set<WebSocket>()

async function main() {
  const app = express()
  app.use(express.json()) // MIGHT NEED TO MOVE THIS FOR STRIPE
  app.disable("x-powered-by")
  app.use(cors())

  app.use((req, res, next) => {
    const reqID = uuidv4()
    req.id = reqID
    next()
  })

  if (process.env.HTTP_LOG === "1") {
    logger.debug("using HTTP logger")
    app.use((req: any, res, next) => {
      req.log.info({ req })
      res.on("finish", () => req.log.info({ res }))
      next()
    })
  }

  app.get("/hc", (req, res) => {
    res.sendStatus(200)
  })

  // Error handler
  app.use((err: any, req: any, res: any, next: any) => {
    if (err instanceof ZodError) {
      return res.status(400).send(`Invalid body: ${err.message}`)
    }

    logger.error({ err, id: req.id })
    res.status(500).send("Internal Server Error")
  })

  const server = app.listen(listenPort, () => {
    logger.info(`API listening on port ${listenPort}`)
  })

  // Initialize WebSocket server
  const wss = new WebSocketServer({ server })

  wss.on("connection", (ws, request) => {
    // Check client type from query parameters
    const clientType = new URL(request.url!, "ws://localhost").searchParams.get(
      "type"
    )

    if (clientType === "bot") {
      logger.info("New bot client connected")
      botClients.add(ws)

      ws.on("close", () => {
        logger.info("Bot client disconnected")
        botClients.delete(ws)
      })
    } else {
      // Assume web client (audio source)
      logger.info("New web client connected")
      webClients.add(ws)

      // Handle incoming audio data from web client
      ws.on("message", (data) => {
        // Broadcast the audio data to all bot clients
        for (const botClient of botClients) {
          if (botClient.readyState === WebSocket.OPEN) {
            botClient.send(data)
          }
        }
      })

      ws.on("close", () => {
        logger.info("Web client disconnected")
        webClients.delete(ws)
      })
    }

    ws.on("error", (error) => {
      logger.error({ error }, "WebSocket error")
    })
  })

  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
  }

  let stopping = false
  Object.keys(signals).forEach((signal) => {
    process.on(signal, async () => {
      if (stopping) {
        return
      }
      stopping = true
      logger.info(`Received signal ${signal}, shutting down...`)
      logger.info("exiting...")
      logger.flush() // pino actually fails to flush, even with awaiting on a callback
      server.close()
      process.exit(0)
    })
  })

  // Add cleanup on server shutdown
  server.on("close", () => {
    for (const client of [...webClients, ...botClients]) {
      client.close()
    }
    webClients.clear()
    botClients.clear()
  })
}

main()
