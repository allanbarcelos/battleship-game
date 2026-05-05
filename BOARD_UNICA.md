## Board única implementada

### Comportamento por estado:

| Estado                                 | Board visível | Label      |
|----------------------------------------|--------------|-----------|
| Antes do jogo                          | Your Squad   | Your Squad |
| Meu turno (myTurn = true)              | Ocean        | Ocean      |
| Turno do adversário (myTurn = false)   | Your Squad   | Your Squad |
| Reconectando / Game over               | Your Squad   | Your Squad |

---

### Como funciona:

- `ocean-grid` começa com `board-hidden` no HTML — só o squad aparece antes do jogo começar  
- `setMyTurn(true)` → remove `board-hidden` do ocean, adiciona no squad, troca o label  
- `setMyTurn(false)` → faz o inverso  
- Ao ser atacado, o jogador vê seu próprio tabuleiro e assiste os navios explodirem em tempo real  
- Ao atacar, vê o ocean com os resultados anteriores  
- Transição de **0.25s** com *fade-in* toda vez que um board aparece  
