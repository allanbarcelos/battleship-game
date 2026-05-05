
## Contador de frotas implementado

### No header (linha inferior):

```
Your Fleet   [board name]   Enemy Fleet
3 / 4       Your Squad      4 / 4
```

---

### Como funciona:

- **Your Fleet** — calculado localmente: conta quantos navios seus ainda têm pelo menos uma célula intacta (`shipCells` vs `destroyedSquares`)  
- **Enemy Fleet** — calculado via protocolo: quando o defensor detecta que todas as células de um navio foram destruídas, envia `sunk: true` no `result` → o atacante incrementa `opponentSunk`  
- Ambos aparecem como **X / 4** (restantes / total)  
- Os contadores ficam ocultos até o jogo começar e são restaurados automaticamente após reconexão  

---

### Rastreamento por navio:

- `initShips` agora popula `shipCells[]` — um array de arrays, onde cada sub-array contém os IDs das células de um navio  
- A detecção de afundamento compara essas células com `destroyedSquares`  

