#!/usr/bin/env bash

set -euo pipefail

echo "Selecione o modo de execução:"
echo " 1) Rodar apenas adição (--add)"
echo " 2) Rodar apenas remoção (--remove)"
echo " 3) Rodar adição e scan (--add --scan)"
echo " 4) Rodar remoção e scan (--remove --scan)"
echo " 5) Rodar apenas scan (--scan)"
echo " 6) Rodar community (--add --community --scan)"
echo " 7) Rodar adição, remoção e scan (--add --remove --scan)"
printf "Opção: "
read -r choice

FLAGS=()

case "$choice" in
  1) FLAGS=(--add) ;;
  2) FLAGS=(--remove) ;;
  3) FLAGS=(--add --scan) ;;
  4) FLAGS=(--remove --scan) ;;
  5) FLAGS=(--scan) ;;
  6) FLAGS=(--add --community --scan) ;;
  7) FLAGS=(--add --remove --scan) ;;
  *) echo "Opção inválida."; exit 1 ;;
esac

echo
echo "Selecione o método de autenticação:"
echo " 1) QR code (default)"
echo " 2) Pairing code (--pairing, requer PAIRING_PHONE na .env)"
printf "Opção: "
read -r auth_choice

case "$auth_choice" in
  1|"") ;;
  2) FLAGS+=(--pairing) ;;
  *) echo "Opção inválida."; exit 1 ;;
esac

echo "Iniciando loop com: pnpm start ${FLAGS[*]}"

while true; do
  git pull --rebase --autostash || echo "git pull falhou, tentando novamente na próxima iteração."

  if ! pnpm build; then
    echo "pnpm build falhou. Aguardando 10 segundos antes de tentar novamente..."
    sleep 10
    continue
  fi

  pnpm start "${FLAGS[@]}"

  echo "App closed. Restarting in 10 seconds..."
  sleep 10
done
