#!/usr/bin/env bash

echo "Selecione a tool para rodar:"
echo "1) Dump de grupos (pnpm tools:dump-groups)"
echo "2) Adicionar worker nas comunidades (pnpm tools:add-worker)"
echo "3) Enfileirar remoção de contato em todos os grupos (pnpm tools:queue-contact-removal)"
echo "0) Sair"

printf "Opção: "
read -r choice

case "$choice" in
  1)
    echo "Executando dump de grupos..."
    if pnpm build; then
      pnpm tools:dump-groups
      exit 0
    else
      echo "pnpm build falhou. Corrija o erro e tente novamente."
      exit 1
    fi
    ;;
  2)
    printf "Telefone do worker (apenas dígitos ou com +): "
    read -r worker
    printf "Rodar em modo dry-run? (s/N): "
    read -r dry_choice
    dry_flag=""
    if [[ "$dry_choice" =~ ^[sS]$ ]]; then
      dry_flag="--dry-run"
    fi

    echo "Executando add worker..."
    if pnpm build; then
      pnpm tools:add-worker -- --worker "$worker" $dry_flag
      exit 0
    else
      echo "pnpm build falhou. Corrija o erro e tente novamente."
      exit 1
    fi
    ;;
  3)
    printf "Telefone do contato (apenas dígitos ou com +): "
    read -r phone

    echo "Executando enfileiramento de remoções..."
    if pnpm build; then
      pnpm tools:queue-contact-removal -- --phone "$phone"
      exit 0
    else
      echo "pnpm build falhou. Corrija o erro e tente novamente."
      exit 1
    fi
    ;;
  0)
    echo "Saindo."
    exit 0
    ;;
  *)
    echo "Opção inválida."
    exit 1
    ;;
esac
