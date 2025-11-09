#!/bin/bash

set -e  # parar em caso de erro

# === CONFIGURAÇÕES ===
NETWORK_NAME="battleship-net"
API_IMAGE="battleship-api"
WEB_IMAGE="battleship-web"

API_CONTAINER="battleship-api"
WEB_CONTAINER="battleship-web"

API_PORT=3000        # porta interna do container API
WEB_PORT=80          # porta pública exposta

# === LIMPAR CONTAINERS E IMAGENS EXISTENTES ===
echo "Removendo containers antigos..."
docker rm -f $API_CONTAINER $WEB_CONTAINER 2>/dev/null || true

echo "Removendo imagens antigas..."
docker rmi -f $API_IMAGE $WEB_IMAGE 2>/dev/null || true

# === CRIAR REDE ===
if ! docker network ls | grep -q "$NETWORK_NAME"; then
  echo "Criando rede Docker: $NETWORK_NAME"
  docker network create $NETWORK_NAME
else
  echo "Rede $NETWORK_NAME já existe"
fi

# === BUILD DAS IMAGENS ===
echo "Compilando imagens..."
docker build -t $API_IMAGE /Users/allan/Projects/battleship-game/api
docker build -t $WEB_IMAGE /Users/allan/Projects/battleship-game/web

# === INICIAR CONTAINERS ===
echo "Iniciando containers..."

# API
docker run -d \
  --name $API_CONTAINER \
  --network $NETWORK_NAME \
  $API_IMAGE

# === AGUARDAR API FICAR DISPONÍVEL ===
echo "Aguardando API iniciar..."
for i in {1..20}; do
  if docker exec $API_CONTAINER sh -c "nc -z localhost $API_PORT"; then
    echo "API está ativa!"
    break
  fi
  echo "Tentando novamente ($i/20)..."
  sleep 2
  if [ $i -eq 20 ]; then
    echo "API não respondeu a tempo. Abortando."
    exit 1
  fi
done

# Web (único acessível externamente)
docker run -d \
  --name $WEB_CONTAINER \
  --network $NETWORK_NAME \
  -p $WEB_PORT:80 \
  -e API_URL=http://$API_CONTAINER:$API_PORT \
  $WEB_IMAGE

echo "Todos os containers foram iniciados com sucesso!"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
