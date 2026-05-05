# Battleship Game

Português | [English](README.md)

**[Jogar o Demo](https://allanbarcelos.github.io/battleship-game)**

## Descrição

Jogo de batalha naval multiplayer que roda inteiramente no navegador — sem servidor. A conexão entre jogadores é estabelecida via WebRTC (peer-to-peer), usando o [ntfy.sh](https://ntfy.sh) apenas como canal de sinalização temporário para trocar dados de conexão. Assim que o jogo começa, todo o tráfego flui diretamente entre os browsers.

## Funcionalidades

- Multiplayer P2P sem servidor via WebRTC DataChannel.
- Posicionamento aleatório dos navios para cada jogador.
- Timer de turno com auto-ataque ao expirar.
- Persistência de sessão — recarregar a página reconecta automaticamente.
- Chat entre os jogadores durante a partida.
- Efeitos sonoros de explosão e água.
- Indicador de conexão direta P2P ou via relay.

## Como Jogar

1. Abra o [demo](https://allanbarcelos.github.io/battleship-game) no navegador.
2. Clique em **Start Game** — um código de 10 caracteres é gerado automaticamente.
3. Compartilhe o código com seu oponente.
4. O oponente insere o código e clica em **Start Game** para entrar.
5. Clique nas células do tabuleiro inimigo para atacar, alternando os turnos.
6. Afunde todos os navios do oponente para vencer.

## Executar Localmente

Sem build ou servidor necessário — basta abrir o `index.html` no navegador:

```bash
git clone https://github.com/allanbarcelos/battleship-game.git
cd battleship-game
open index.html
```

## Tecnologias

- JavaScript puro (sem frameworks, sem dependências)
- WebRTC (`RTCPeerConnection` + `RTCDataChannel`)
- [ntfy.sh](https://ntfy.sh) para sinalização (troca de SDP + ICE apenas)

## Autores

- Allan Barcelos

## Licença

Este projeto está licenciado sob a [MIT License](https://opensource.org/licenses/MIT).


Estou aceitando patrocinio para novos projetos [Buy me a coffee](https://www.buymeacoffee.com/allanbarcelos)
