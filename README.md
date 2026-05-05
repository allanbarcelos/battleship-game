# Battleship Game

[Português](README.pt.md) | English

**[Play the Demo](https://allanbarcelos.github.io/battleship-game)**

## Description

Multiplayer Battleship game that runs entirely in the browser — no server required. Connection between players is established via WebRTC (peer-to-peer), using [ntfy.sh](https://ntfy.sh) only as a temporary signaling channel to exchange connection data. Once the game starts, all traffic flows directly between browsers.

## Features

- Serverless P2P multiplayer via WebRTC DataChannel.
- Random ship placement for each player.
- Turn timer with auto-attack on timeout.
- Session persistence — reloading the page reconnects automatically.
- In-game chat between players.
- Explosion and water sound effects.
- Shows whether the connection is direct P2P or relayed.

## How to Play

1. Open the [demo](https://allanbarcelos.github.io/battleship-game) in your browser.
2. Click **Start Game** — a 10-character code is generated automatically.
3. Share the code with your opponent.
4. Your opponent enters the code and clicks **Start Game** to join.
5. Take turns clicking the opponent's grid to attack.
6. Sink all enemy ships to win.

## Running Locally

No build step or server needed — just open `index.html` in a browser:

```bash
git clone https://github.com/allanbarcelos/battleship-game.git
cd battleship-game
open index.html
```

## Tech Stack

- Vanilla JavaScript (no frameworks, no dependencies)
- WebRTC (`RTCPeerConnection` + `RTCDataChannel`)
- [ntfy.sh](https://ntfy.sh) for signaling (SDP + ICE exchange only)

## Authors

- Allan Barcelos

## License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).


I accept supports for new projects [Buy me a coffee](https://www.buymeacoffee.com/allanbarcelos)
