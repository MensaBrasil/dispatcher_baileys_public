Dispatcher — Operação e Documentação (add/remove/scan)

Visão geral

- Objetivo: Orquestrar ciclos de manutenção de grupos WhatsApp (via Baileys + DB + Redis), executando as tarefas de adicionar, remover e escanear uma única vez por ciclo.
- Ciclo: Executa exatamente uma vez por intervalo configurável (em segundos) via `CYCLE_DELAY_SECONDS`. Entre ações que usam o socket e entre tarefas, há atrasos aleatórios para reduzir risco de ban.

Execução

- CLI: `pnpm start [--add] [--remove] [--scan]`
  - Sem flags: executa add, remove e (opcionalmente) scan se `ENABLE_SCAN=true`.
  - Com flags: executa apenas as tarefas selecionadas.
- Loop principal: inicia após `connection=open` no Baileys e repete a cada `CYCLE_DELAY_SECONDS`.
- Delays: controlados por `ACTION_DELAY_MIN`/`ACTION_DELAY_MAX`/`ACTION_DELAY_JITTER` (segundos) e aplicados entre as tarefas.
  `SCAN_DELAY` controla atraso por grupo durante o scan.

Ambiente (variáveis relevantes)

- `CYCLE_DELAY_SECONDS` (padrão: 1800): intervalo do loop, em segundos.
- `CYCLE_JITTER_SECONDS` (padrão: 0): jitter aleatório em segundos somado/subtraído do intervalo para evitar padrões.
- `ACTION_DELAY_MIN` (padrão: 1), `ACTION_DELAY_MAX` (padrão: 3), `ACTION_DELAY_JITTER` (padrão: 0.5): atraso aleatório entre tarefas.
- `ENABLE_SCAN` (padrão: false): habilita tarefa de scan quando nenhuma flag é passada.
- `WPP_STORE_GROUP_MESSAGE_CONTENT` (padrão: false): quando `true`, armazena o conteúdo textual das mensagens de grupos no banco de dados.
- Credenciais de Postgres e Redis: ver `.env.example`.

addTask — addMembersToGroups(groups)

- Caminho: `src/core/addTask.ts`
- Assinatura: `async function addMembersToGroups(groups: { id: string; subject?: string; name?: string }[]): Promise<void>`

O que faz

- Lê, por grupo, a fila de requisições de adição no Postgres (tabela `group_requests` via `getWhatsappQueue`).
- Para cada requisição elegível, prepara um item com:
  - `type: "add"`
  - `request_id` e `registration_id` (IDs da requisição/registro)
  - `group_id` (id do grupo)
  - `group_type` (derivado do nome/assunto do grupo via `checkGroupType`)
- Envia todos os itens para o Redis na fila `addQueue`:
  - Antes, limpa a fila com `clearQueue("addQueue")` para evitar duplicidades.
  - Em seguida, publica com `sendToQueue(queueItems, "addQueue")`.
- Recursos: ao final, encerra conexões Redis (`disconnect`) e libera o pool do Postgres (`closePool`).

Entrada esperada

- `groups`: lista mínima com `id` e opcionalmente `subject`/`name`. O orquestrador fornece esses dados a partir do `groupFetchAllParticipating()` do Baileys.

Regras/filtragem de requisições

- `getWhatsappQueue(group_id)` retorna apenas requisições:
  - `no_of_attempts < 3`
  - `fulfilled = false`
  - `last_attempt < now() - 1 day` ou `last_attempt is null`
- Cada item é enriquecido com `group_type` conforme heurísticas de `checkGroupType` (ex.: grupos JB/MJB/…)

Erros e logs

- Ao preparar itens por requisição/grupo, erros são capturados e logados com contexto (grupo, registration_id, etc.).
- Após publicar no Redis, loga o total de itens enfileirados ou erro em caso de falha.

Boas práticas e consistência

- addTask hoje fecha Redis e Postgres ao final. Quando usada numa orquestração contínua (loop), isso força reabertura das conexões no próximo passo. Funciona, mas pode adicionar overhead.
  - Alternativa (futura): mover o fechamento de conexões para o orquestrador, mantendo as tasks puramente funcionais; padronizar com `removeTask` e `scanTask`.
- A função não interage com o socket do Baileys; apenas consome DB e publica no Redis. O delay entre ações de socket é aplicado no orquestrador.

Uso isolado (para testes)

- Invoque a função passando uma lista de grupos mínima:
  ```ts
  await addMembersToGroups([{ id: "123@g.us", subject: "MB | Exemplo" }]);
  ```
  Certifique-se de configurar Postgres/Redis no `.env` e que a consulta `getWhatsappQueue` retorna requisições.

removeTask — removeMembersFromGroups(groups, phoneNumbersFromDB)

- Caminho: `src/core/removeTask.ts`
- Assinatura: `async function removeMembersFromGroups(groups: MinimalGroup[], phoneNumbersFromDB: Map<string, PhoneNumberStatusRow[]>): Promise<void>`

O que faz

- Percorre membros de cada grupo (a partir de `participants` do Baileys, já fornecidos pelo orquestrador) e cruza com o mapa de telefones/estado do DB (`phoneNumbersFromDB`).
- Aplica regras por tipo de grupo e estado do membro para decidir remoção:
  - Inconsistências por faixa etária JB/MJB/Não-JB (via `isRegularJBGroup`, `isMJBGroup`, `isNonJBGroup`).
  - Grupo “MB | Mulheres”: remove números com `gender = Masculino`.
  - Grupo “R.JB | Familiares de JB 12+”: remove quem não é representante legal.
  - `status = Inactive`: antes de remover, chama `triggerTwilioOrRemove(phone, "mensa_inactive")` para respeitar período de espera/comunicação.
  - Números não encontrados no DB: idem acima, com razão `"mensa_not_found"`.
  - Respeita listas `DONT_REMOVE_NUMBERS` e `EXCEPTIONS` (variáveis de ambiente, separadas por vírgula).
- Para cada decisão de remoção, enfileira item no Redis `removeQueue` com:
  - `type: "remove"`, `registration_id` (ou `null`), `groupId`, `phone`, `reason`, `communityId` (quando disponível).
- Limpa `removeQueue` antes de inserir e desconecta do Redis ao final.

Campos/formatos

- `MinimalGroup`: `{ id, subject?, name?, participants, announceGroup? }` (fornecido pelo orquestrador a partir do Baileys).
- `PhoneNumberStatusRow`: inclui `status (Active|Inactive)`, `jb_under_10`, `jb_over_10`, `is_adult`, `is_legal_representative`, `gender`, etc.

Regras em detalhes

- JB regular vs M.JB vs Não-JB:
  - JB regular: remove `jb_under_10` em grupos JB; M.JB: remove `jb_over_10`; Não-JB (com exceções nominais): remove qualquer JB.
  - Grupos AJB não aplicam as regras de idade.
- Twilio/espera: `triggerTwilioOrRemove` registra comunicação e pode acionar flow do Twilio Studio. Retorna `true` apenas quando período de espera terminou, indicando que remoção é segura.

Observações/consistência

- Assim como na addTask, a fila é limpa previamente. Em ambientes com consumidor lento, isso pode descartar pendências. Alternativa futura: deduplicação por `phone+groupId`/`request_id`.
- `removeTask` fecha apenas Redis; DB é usado a partir do mapa pré-carregado pelo orquestrador.

scanTask — scanGroups(groups, phoneNumbersFromDB)

- Caminho: `src/core/scanTask.ts`
- Assinatura: `async function scanGroups(groups: MinimalGroup[], phoneNumbersFromDB: Map<string, PhoneNumberStatusRow[]>): Promise<void>`

O que faz

- Para cada grupo:
  - Aplica atraso opcional por grupo (`SCAN_DELAY`, segundos) para reduzir taxa de leitura/uso de recursos.
  - Obtém membros anteriores do DB (`member_groups`), compara com os atuais do grupo (via `participants`).
  - Marca saídas: para números anteriores que não estão mais no grupo, chama `recordUserExitFromGroup`.
  - Marca entradas: para números novos, tenta conciliar com `phoneNumbersFromDB`:
    - Se encontrar, registra com `recordUserEntryToGroup` incluindo `registration_id` e `status` (Active/Inactive).
    - Se não encontrar, loga aviso informativo (sem inserir no DB).
  - Concilia requisições de adição: lê `getWhatsappQueue(groupId)` e, usando os 8 últimos dígitos de cada telefone do registro, confere se a entrada já se concretizou; se sim, marca `registerWhatsappAddFulfilled(request_id)`.

Entradas/saídas e formatos

- `MinimalGroup`: `{ id, subject?, name?, participants }`.
- `phoneNumbersFromDB`: mapa resultante de `preprocessPhoneNumbers(getPhoneNumbersWithStatus())` no orquestrador.
- Ignora números listados em `DONT_REMOVE_NUMBERS` durante o registro de entradas.

Observações

- O scan não utiliza o socket diretamente; usa conteúdo já trazido pelo orquestrador (Baileys) e o DB. O delay por grupo (`SCAN_DELAY`) ajuda a controlar o ritmo entre grupos.
- Em caso de erro por grupo, o fluxo continua para o próximo (robustez por `try/catch`).

**Tools**

- Objetivo: utilitários de linha de comando para inspeção e operações pontuais via Baileys, fora do ciclo principal.

- `tools:dump-groups`
  - Caminho: `src/tools/dumpGroups.ts`
  - Executa: `pnpm tools:dump-groups`
  - O que faz:
    - Abre sessão Baileys (QR no terminal, se necessário) e busca todos os grupos com `groupFetchAllParticipating()`.
    - Gera dois arquivos em `tools_results/`:
      - `groups_dump_<timestamp>.json`: dump completo dos metadados retornados pelo Baileys.
      - `groups_summary_<timestamp>.json`: resumo com totais (comunidades, announces, admin, addressingMode, classificação por nome) e lista de comunidades (id, subject, contagem de subgrupos).
  - Requisitos:
    - Sessão válida em `./auth` (ou escaneie o QR exibido).
    - `.env` para nível de log do Baileys opcional (`BAILEYS_LOG_LEVEL`).

- `tools:add-worker`
  - Caminho: `src/tools/addNewWorker.ts`
  - Executa: `pnpm tools:add-worker -- --worker <telefone>`
    - Exemplo dry-run: `pnpm tools:add-worker -- --worker 5511999999999 --dry-run`
  - O que faz (estado atual):
    - Valida o telefone do worker na tabela `whatsapp_workers` usando `getAllWhatsAppWorkers()`.
    - Conecta via Baileys e identifica todas as comunidades e seus grupos de avisos (`isCommunityAnnounce = true`).
    - Para cada grupo de avisos:
      - Verifica se o worker já é membro; se sim, marca como `already` e não tenta adicionar.
      - Tenta adicionar o worker somente se o bot tiver permissão (admin/superadmin) no próprio grupo de avisos ou na comunidade.
      - Aplica delay aleatório entre 0 e 120 segundos entre adições (`delaySecs`).
    - Não realiza promoção a admin (função removida por limitações e erros 400/bad-request observados).
    - Salva relatório detalhado em `tools_results/add_worker_<telefone>_<timestamp>.json` com por-comunidade e por-grupo de avisos.
  - Requisitos:
    - Sessão válida em `./auth` (QR no terminal, se necessário).
    - `.env` com Postgres configurado (consulta de `whatsapp_workers`).
  - Observações:
    - Operação limitada a grupos de avisos; não tenta adicionar na comunidade.
    - Campos do relatório por grupo: `action` ∈ `already|dry-run-add|added|failed|skipped` e `error` opcional.
