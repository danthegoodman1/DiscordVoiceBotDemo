import { useState, useRef } from "react"
import "./App.css"

function App() {
  const [isRecording, setIsRecording] = useState(false)
  const websocketRef = useRef<WebSocket | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)

  const startStreaming = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream

      const ws = new WebSocket("ws://localhost:8080")
      websocketRef.current = ws

      // Specify Opus codec in MediaRecorder options
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
        audioBitsPerSecond: 24000,
      })
      console.log("made media recorder")

      // Debug the format being used
      console.log("MediaRecorder configured with:", {
        mimeType: mediaRecorder.mimeType,
        state: mediaRecorder.state,
        audioBitsPerSecond: mediaRecorder.audioBitsPerSecond,
      })

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          // Debug the data being sent
          // console.log("Sending audio chunk:", {
          //   size: event.data.size,
          //   type: event.data.type,
          // })

          // Optional: Inspect the actual data
          // event.data.arrayBuffer().then((buffer) => {
          //   console.log("Audio buffer details:", {
          //     byteLength: buffer.byteLength,
          //     // Show first few bytes for debugging
          //     firstBytes: new Uint8Array(buffer).slice(0, 10),
          //   })
          // })

          ws.send(event.data)
        }
      }

      mediaRecorder.start(10) // 10ms chunks, needs to be batched at the WS level, any more and it sounds choppy (probably due to the latency being substantially lower than the chunk interval?)
      setIsRecording(true)
    } catch (error) {
      console.error("Error starting stream:", error)

      // More detailed error handling
      if (error instanceof DOMException) {
        console.error("MediaRecorder error details:", {
          name: error.name,
          message: error.message,
        })
      }
    }
  }

  const stopStreaming = () => {
    if (websocketRef.current) {
      websocketRef.current.close()
      websocketRef.current = null
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }

    setIsRecording(false)
  }

  return (
    <div className="container">
      <h1>Audio Streaming</h1>
      <button onClick={isRecording ? stopStreaming : startStreaming}>
        {isRecording ? "Stop Streaming" : "Start Streaming"}
      </button>
      {isRecording && <p>Currently streaming audio...</p>}
    </div>
  )
}

export default App
