# Regra global de negocio para grupos de WhatsApp

Esta e a regra de negocio global adotada pelo `dispatcher_baileys` e pelo `worker_baileys`.

## Grupos gerenciados automaticamente

Somente dois tipos de grupo entram na automacao:

- `MB`
- `RJB`

Qualquer outro grupo fica fora do fluxo automatico de add/remove.

## Classificacao dos grupos

### MB

Um grupo e `MB` quando o nome:

- comeca com `Mensa` e contem `Regional`; ou
- comeca com `Avisos Mensa`; ou
- comeca com `MB |`.

### RJB

Um grupo e `RJB` quando o nome:

- comeca com `R.JB |`; ou
- comeca com `R. JB |`.

## Elegibilidade para entrada e permanencia

### MB

Pode entrar e permanecer em grupo `MB` quem cumprir todos os requisitos abaixo:

- ser membro com idade maior ou igual a 18 anos;
- ter cadastro ativo no momento;
- ter no cadastro do membro o telefone usado no WhatsApp.

### RJB

Pode entrar e permanecer em grupo `RJB` quem cumprir todos os requisitos abaixo:

- ser telefone de responsavel legal vinculado a um membro com idade menor ou igual a 17 anos;
- o cadastro ativo considerado e o do menor vinculado;
- o telefone usado no WhatsApp deve existir no cadastro de `RESPONSAVEL`;
- se o jovem nao tiver telefone proprio, o telefone do responsavel pode aparecer tambem no cadastro do membro, mas a elegibilidade continua sendo pelo vinculo de responsavel.

## Regras globais adicionais

### Suspensao

- telefone ou cadastro em lista de suspensao nao entra em grupo;
- se ja estiver em grupo gerenciado, entra em remocao prioritaria automatica;
- suspensao vence a lista de convidados.

### Convidado

- telefone na lista de convidados nao e removido automaticamente;
- excecao: se o mesmo telefone tambem estiver suspenso, a suspensao prevalece.

### Cadastro ativo e carencia

- nao existe mais carencia fixa de `14 dias` por vencimento;
- `transferred = true` nao mantem mais o cadastro como ativo;
- quando um telefone deixa de se enquadrar por atividade, o sistema envia a primeira mensagem automatica e inicia a carencia;
- a remocao so ocorre depois do prazo configurado, contado a partir dessa primeira comunicacao.

## Regras praticas de remocao

### MB

Um telefone sai de `MB` quando:

- nao corresponde mais a telefone de membro adulto elegivel; ou
- o cadastro deixou de estar ativo e a carencia apos a mensagem automatica expirou; ou
- o telefone nao e encontrado no banco e a carencia apos a mensagem automatica expirou; ou
- o telefone esta suspenso.

### RJB

Um telefone sai de `RJB` quando:

- nao corresponde mais a telefone de responsavel legal de menor elegivel; ou
- o menor vinculado deixou de estar ativo e a carencia apos a mensagem automatica expirou; ou
- o telefone nao e encontrado no banco e a carencia apos a mensagem automatica expirou; ou
- o jovem vinculado deixou de estar na faixa de ate 17 anos; ou
- o telefone esta suspenso.
