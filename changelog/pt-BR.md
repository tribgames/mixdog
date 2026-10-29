# Registro de alterações

Principais mudanças, das mais recentes para as mais antigas. O pipeline de Deploy se recusa a publicar uma versão enquanto a seção Unreleased estiver vazia e a carimba com a versão publicada.

## Unreleased

Melhoramos a estrutura de agentes com o Explore, um agente dedicado à exploração, e uma verificação mais rigorosa com a habilidade Test Suite, além do suporte ao Vertex AI e a várias contas por conector.

### Novos recursos

- **Explore** — Adicionado um agente opcional de exploração somente leitura ao qual o Lead pode delegar várias perguntas sobre o código de uma só vez; escolha o modelo em Workflows → Agentes integrados.
- **Habilidade Test Suite** — Adicionada uma habilidade integrada para escrever, executar, diagnosticar e limpar os testes de um projeto.
- **Vertex AI** — Adicionado o Vertex AI com modelos Gemini, Claude e abertos, fazendo login com chave de conta de serviço, login do gcloud ou chave de API no modo expresso (#249).
- **Várias contas em um conector** — Adicionada a opção de conectar várias contas a um mesmo conector; os agentes usam a última conta utilizada, a menos que você indique outra.
- **Chaves e cabeçalhos de provedor personalizado** — Adicionadas chaves de API extras que assumem quando a cota de uma acaba, além de cabeçalhos HTTP personalizados em cada requisição (#233, #239).
- **Permissões de ferramentas de conectores para bots** — Adicionadas as opções Auto, Requer aprovação e Desativado por ferramenta para cada conector no perfil do bot (#264).
- **Aprovação pelo bot na tela** — Adicionada a solicitação com os botões Permitir e Negar direto no balão de fala do bot na tela.
- **Parar todos os comandos em segundo plano** — Adicionado o comando `/stop` para encerrar todos os comandos em segundo plano de uma sessão, além de `/shells` e `/mcp login` no aplicativo para computador.

### Alterações

- Os agentes agora corrigem a causa de uma verificação que falhou, em vez de apenas executá-la novamente, aumentar o tempo limite ou ignorá-la.
- Os check-ins periódicos dos bots e o pré-aquecimento do cache de prompt agora ficam desativados por padrão.
- O aplicativo para computador e a CLI agora seguem o proxy do sistema, aplicando scripts PAC e exceções por endereço no computador e mantendo conexões diretas para endereços locais e da rede local (LAN).
- As linhas de atividade de ferramentas agora mostram o tempo decorrido apenas enquanto o comando está em execução.

### Correções de bugs

- Corrigido o problema em que Parar e Liberar mesmo assim deixavam processos filhos de um comando já finalizado em execução (#259).
- Corrigido o problema em que uma sala em grupo repetia "não conseguiu responder" para cada bot quando o limite de uso acabava; agora ela para uma única vez e informa o motivo.
- Corrigido o problema em que sessões longas ou compactadas não rolavam de volta até a primeira mensagem no computador e no celular.
- Corrigido o problema em que uma sessão exibia "Sessão indisponível" enquanto outras sessões ocupadas enviavam atualizações grandes.
- Corrigida a falha ao importar conversas do Codex mantidas apenas como arquivos compactados (#262).
- Corrigido o login de conectores que repetia o erro "Unrecognized client_id" depois que o serviço esquecia o registro do Mixdog (#269).
- Corrigido o corte de URLs longas de login na TUI e adicionado o atalho `Ctrl+Y` para copiá-las (#261).
- Corrigida a falha ao iniciar a entrada de voz em PCs com Windows sobrecarregados.
- Corrigido o problema em que células com texto em chinês ou japonês ultrapassavam a borda da tabela.

## v1.4.1 - 2026-10-27

Corrigidos o login via SSH, as falhas de configuração de acesso ao PC e a interrupção de agentes em modelos da Anthropic, e adicionado um alternador de visualização para as abas lado a lado do Visualize.

### Novos recursos

- **Login sem navegador** — Adicionado o login por código de dispositivo para ChatGPT e Grok, exibindo a URL ou o código de login no painel TUI via SSH ou sem tela (#242).
- **Alternador de visualização do Visualize** — Adicionado um alternador de visualização à pílula de zoom de uma aba lado a lado do Visualize, para exibir ambos os painéis ou um por vez.
- **Instalação de APK a partir do chat** — Adicionada a abertura de um APK baixado no instalador de pacotes do Android em vez da folha de compartilhamento (#241).

### Alterações

- Alterados os bots para acessarem outro bot por seu bot id ao enviar, ler ou verificar.
- Alterados a barra lateral, os pontos de não lido e o acionamento de agentes para responderem mais rapidamente com listas longas de sessões.

### Correções de bugs

- Corrigida a falha na configuração de acesso ao PC em computadores cuja raiz da unidade possui uma permissão apenas de herança, e exibido o motivo pelo qual uma aprovação não foi concluída (#251).
- Corrigido o problema em que agentes em modelos da Anthropic eram interrompidos por inatividade enquanto pensavam ou gravavam um arquivo grande (#248).
- Corrigido o problema em que agentes em rotas personalizadas de Responses eram considerados inativos antes de sua primeira saída (#244).
- Corrigido o erro "bad port" ao executar Computer Use, Browser Use e retornos de chamada de login em alguns computadores.
- Corrigida a escolha de um modelo principal no provedor de um fallback que falhava com "duplicate route provider".
- Corrigida a alternância automática para um modelo de fallback que enviava todas as ferramentas MCP de uma só vez.
- Corrigida a perda de histórico inicial, títulos ou páginas em conversas importadas do Claude e Codex, e exibido o uso de ferramentas como linhas de atividade recolhidas (#245).
- Corrigidos os worktrees órfãos que permaneciam e a branch padrão que era incorporada a um worktree gerenciado (#247).
- Corrigido o bot que continuava sendo exibido como trabalhando após o término do trabalho delegado e a falta do ponto de conclusão em uma sessão compactada.
- Corrigida a recriação do cache de prompts após uma solicitação interrompida ou reinicialização.
- Corrigida a perda da borda inferior em tabelas ou blocos de código ao final de uma resposta, e tabelas estreitas em celulares que perdiam o espaçamento entre células.

## v1.4.0 - 2026-10-27

Aprimorado o trabalho remoto pelo celular junto com Browser Use e Computer Use, e simplificado o harness de agentes para ignorar verificações redundantes e concluir tarefas mais rapidamente.

### Novos recursos

- **Tela remota do PC** — Adicionada a visualização e o controle da tela do seu PC a partir do celular por meio de uma conexão direta WebRTC com teclas especiais e uma pílula de status no PC.
- **Acesso ao PC** — Adicionado o acesso opcional a solicitações de administrador, à tela de bloqueio e a `Ctrl`+`Alt`+`Del` a partir do celular, aprovado uma vez na configuração de Computer Use ou com sua senha do Windows.
- **Visualização ao vivo do navegador** — Adicionada a transmissão do navegador integrado para o celular via WebRTC, ajustando páginas assumidas à tela com digitação direta pelo teclado do celular.
- **Controles de notificação** — Adicionadas configurações de notificação por dispositivo, silenciamento de conversas, horários de silêncio e notificações de erro em Configurações → Notificações, com Permitir em notificações de aprovação (#221, thanks @dislight1123).
- **Trabalho delegado por bots** — Adicionada uma linha em tempo real por tarefa abaixo da resposta para trabalhos que um bot delega, exibindo o progresso e permitindo responder a perguntas no chat.
- **Logins salvos** — Adicionado o login automático com credenciais salvas e códigos de uso único, gerenciado em Configurações → Autenticação, sem que o modelo veja os dados secretos.
- **Importação de logins do Chrome** — Adicionada a importação de logins salvos do Chrome, incluindo os criptografados vinculados a aplicativos mais recentes, na página de Logins remodelada com um alternador de salvar/manter conectado.
- **Login a partir do seu e-mail** — Adicionada a abertura de links de login e o preenchimento de códigos a partir do seu e-mail verificado, lembrando qual provedor de identidade cada site utilizou.
- **Logins salvos no Chrome e Edge** — Adicionado o preenchimento por Computer Use de um login salvo no seu próprio Chrome ou Edge sem expô-lo ao modelo.
- **Aquecimento de cache de prompts** — Adicionado o aquecimento automático de cache de prompts para modelos Anthropic em Configurações → Contexto, aprendendo seus hábitos de retorno e aquecendo bots antes de execuções agendadas.
- **Mais conexões Google** — Adicionada a conexão de mais contas Google ao Gmail, Calendar e Drive, escolhendo a conta por solicitação, com uma solicitação de login clara.

### Alterações

- Alterados os agentes para verificar uma única vez após todas as edições em vez de no meio da tarefa, executar chamadas de ferramentas independentes juntas e manter as atualizações de progresso curtas.
- Alteradas as Configurações em quatro seções: Básico, Comportamento da IA, Integrações e Suporte.
- Alterado o menu de Sessões para permitir escolher quais seções da barra lateral exibir.
- Alterados digitação, alternância de sessões e abas, Busca, Configurações, painéis laterais, terminal e Alterações para abrirem instantaneamente, com animações de status mais suaves.
- Alteradas as aprovações de sessões delegadas por bots para aparecerem em todos os chats que aguardam por elas, com a mesma redação e atalhos em cada cartão de aprovação.
- Alteradas as linhas de sessões e bots para exibir um triângulo âmbar para espera de aprovação, um ícone de interrogação para perguntas e a contagem de tarefas em espera.
- Alteradas as sessões de tarefas de bots e subagentes para terem seu próprio ponto de não lido, marcado como lido junto com o chat ao qual respondem.
- Alterado o telefone emparelhado para ler, pré-visualizar, baixar e abrir arquivos da mesma forma que o PC.
- Alterado o seletor de arquivos `@` para classificar caminhos rasos primeiro, abrir com trabalhos recentes e encontrar arquivos em pastas vinculadas (#228, thanks @reeves-ai-lch).
- Alterado o Visualize para abrir páginas a partir de qualquer pasta local, nomeando páginas de índice pelo nome da pasta.
- Alterados o popup de uso e a barra de uso fixada para exibir cada limite como uma linha sobre uma barra de largura total.
- Alterada a ferramenta shell para aceitar um diretório de trabalho opcional e recusar comandos de pausa sleep de 2 segundos ou mais.
- Alteradas as execuções de terminal de agentes e páginas de navegador para revelarem sua aba no PC e em dispositivos emparelhados, abertas diretamente das linhas da transcrição.
- Alterado o Browser Use para limitar as páginas em segundo plano por sessão e fechá-las após o término de um turno.
- Alteradas as esperas de novas tentativas para exibir um motivo fixo e uma contagem regressiva em tempo real em vez do texto de erro bruto.
- Alterados os chats de bots para não exibirem cartão de arquivos modificados sob uma resposta, separarem mensagens distantes e compartilharem uma única linha para transferência e horário.
- Alterada a lista de idiomas para exibir o coreano pelo seu próprio nome.
- Alterada a verificação periódica do Mixy para rodar a cada hora por padrão, com intervalo selecionável em Configurações → Bots.
- Alterado o aplicativo para celular para se conectar diretamente ao seu PC quando a rede permitir, revertendo automaticamente para o relay.
- Alterados os painéis laterais para compartilharem uma única largura, ajustável de 280 a 1160 pixels.
- Ajustado o dock lateral do celular para fechar deslizando em qualquer lugar da folha, com animação mais suave para linhas da gaveta e efeitos de brilho do texto.

### Correções de bugs

- Corrigida a perda de layout de painéis divididos quando o armazenamento local do aplicativo é redefinido.
- Corrigido o deslocamento de bordas, divisores e cores de painéis ao abrir ou fechar um painel lateral.
- Corrigido o desaparecimento do conteúdo da gaveta do celular durante o fechamento por deslizamento.
- Corrigido o bot fixado que saía da extremidade direita do compositor após o fechamento de um painel lateral, e chats caindo uma linha ao entrar.
- Corrigida a linha de um bot que não girava nem exibia pontos de não lido enquanto suas sessões de tarefas trabalhavam.
- Corrigido o clique em uma notificação da área de trabalho que mantinha a barra lateral na sessão anterior ou não fazia nada com a janela oculta.
- Corrigida a resposta a um cartão de pergunta no final de um chat que impedia o histórico de acompanhar a resposta.
- Corrigidas as sessões de tarefas criadas com um modelo explícito que falhavam com "service is not defined".
- Corrigida a verificação periódica do Mixy que era executada enquanto o aplicativo de desktop ainda estava em uso.
- Corrigido o Computer Use digitando em janelas que se sobrepunham sozinhas e escrevendo em campos somente leitura ou desativados.
- Corrigidas senhas salvas com mais de 4.096 caracteres que eram truncadas e dados secretos com menos de quatro caracteres que ficavam sem máscara nos chats.
- Corrigida a perda de uma nova tentativa enfileirada de um turno com falha e da escolha de habilidade de uma rotina após a reinicialização (#229, thanks @22nsuk).
- Corrigida a retomada automática de cota via SSH que lia a cota do servidor em vez da do PC quando o PC mantinha o login (#232, thanks @22nsuk).
- Corrigido `Option`+`Left`/`Right` que não se movia por palavras em campos de texto no macOS (#230, thanks @wudys).
- Corrigida a seleção de contexto do perfil de um agente que não era preservada (#226, thanks @22nsuk) e falhas do Cursor em conflitos de contexto armazenado (#225, thanks @22nsuk).
- Corrigida uma sessão de tarefas em espera exibida como travada e uma conta de conector desativada que não podia ser reativada.
- Corrigida a perda de nova tentativa em erro de turno por login expirado e o painel do navegador exibindo uma página em branco após fechar sua última página.
- Corrigido o erro "This conversation has no such attachment." ao clicar em um anexo em conversas longas ou compactadas.
- Corrigido o painel do agente no celular exibindo um título Perfil duplicado acima de suas próprias abas.
- Corrigida a visualização Alterações do painel lateral intitulada Perfil após o perfil de um bot ter sido aberto lá pela última vez.
- Corrigida a lista de sessões e o chat em celulares Android travando após rolagem rápida e saltando em seguida.
- Corrigidos os cabeçalhos de seção da barra lateral que permaneciam destacados após um clique e seu indicador giratório que sumia enquanto o botão de menu era exibido.`
- Corrigida a compactação de uma conversa que descartava as habilidades e regras atuais em vez de reconstruí-las a partir de fontes ativas.
- Corrigido o Mixy aparecendo sozinho após uma verificação de inicialização com falha, lendo verificações periódicas e depois desaparecendo (#243, thanks @Jichiro-S).
- Corrigidas as sessões existentes ignorando as configurações atuais de compactação e bifurcações sendo compactadas cedo demais (#237, thanks @22nsuk; #238, thanks @skywhale345).
- Corrigidos bots solicitando no chat que você resolva um CAPTCHA ou etapa de login em vez de passar a página.

## v1.3.5 - 2026-10-24

Adicionadas reações com emojis, revisões regulares e logins de modelos em servidor SSH, com conectores verificados do Google, gestos de deslizar gavetas no celular e amplas correções.

### Novos recursos

- **Reações com emojis** — Adicionadas reações com emojis de bots em mensagens de usuários com uma opção em Configurações → Geral → "Reações".
- **Revisões regulares** — Adicionadas revisões em segundo plano a cada 30 minutos em Configurações → Perfil, onde seu bot principal verifica sessões ativas e acorda apenas quando algo precisa de atenção.
- **Logins em servidor SSH** — Adicionada a execução de modelos usando os próprios logins de provedores de um servidor SSH e a definição de um arquivo de chave privada ao conectar (#204).
- **Conectores do Google** — Adicionados conectores integrados do Google Agenda e Drive com login verificado, exigindo todas as permissões e mantendo o Gmail com senhas de app.
- **Navegação por deslize no celular** — Adicionado o deslizamento horizontal em qualquer parte do celular para abrir a lista de sessões ou o dock de arquivos.

### Alterações

- As visualizações do Office foram alteradas para serem renderizadas pelo Microsoft Office quando o LibreOffice estiver ausente, detectar instalações imediatamente e solicitar a senha de arquivos protegidos.
- Agendamentos, bots, salas e sessões Lead foram alterados para permitir renomeação a partir de seus menus, mantendo intactos os horários de execuções únicas.
- O armazenamento de segredos no Linux foi alterado para usar arquivos locais protegidos como alternativa quando nenhum chaveiro estiver disponível, explicando por que as chaves não podem ser lidas (#204).
- Os chats de bots foram alterados para exibir trocas com outras sessões em linha, e clicar no balão de fala do bot principal o dispensa.
- O aplicativo foi alterado para abrir mais rápido ao exibir o chat e a lista de sessões antes de carregar os agentes, e alternar de volta para uma sessão recente agora a exibe instantaneamente.

### Correções de bugs

- Corrigidos bots de salas desativados que continuavam jogando seus turnos, nomeando-os claramente quando mencionados (#215).
- Corrigidos cartões de aprovação que roubavam o foco enquanto se digitava no campo de mensagem, e exibida uma marca de aprovação pendente do navegador na lista de sessões do celular.
- Corrigidas saídas longas de ferramentas no celular que não carregavam através de Mostrar saída completa, e chats abertos travados em esqueletos de carregamento.
- Corrigida a alternância entre sessões que enviava um rascunho em andamento no campo de mensagem para o chat errado (#217).
- Corrigido o fechamento inesperado de menus de contexto e de linha sempre que um agente em segundo plano era atualizado ou a transcrição rolava.
- Corrigida a falha no login automático do navegador diante de desafios de CAPTCHA ou falhas do worker, mantendo a identidade do navegador consistente nas verificações do Cloudflare.
- Corrigidos pares substitutos de emojis corrompidos que causavam falhas em solicitações de modelos, e isoladas janelas de cota cheia para que bloqueiem apenas os modelos afetados (#209).
- Corrigidos agentes finalizados marcados como cancelados ao serem fechados, permitindo a edição de definições diretamente no local (#211, #216).

## v1.3.4 - 2026-10-23

Corrigida a rolagem no celular que parava ou pulava, listas de modelos sem modelos de provedores e tabelas que tremiam durante o streaming de respostas.

### Correções de bugs

- Corrigido o deslizamento rápido no Android que parava no meio na lista de sessões, inclusive logo após retornar ao aplicativo.
- Corrigida a rolagem para cima em um chat no Android que travava ou pulava no meio do caminho.
- Corrigidas as tabelas que tremiam lateralmente enquanto uma resposta era transmitida em um chat de código.
- Corrigido o Stop de uma sala que perdia a resposta, aprovação ou mensagem de um membro terminada logo em seguida (#201).
- Corrigidas as opções selecionadas em um cartão de perguntas que eram perdidas ao responder pelo campo de mensagem (#202).
- Corrigida a falha ao iniciar um subagente quando seu modelo era informado pelo nome de exibição (#203).
- Corrigidos os agentes que pediam para fechar seus subagentes finalizados em vez de fechá-los eles mesmos.
- Corrigidas as listas de modelos no editor de agentes, no perfil do bot e no campo de mensagem que não exibiam modelos do OpenCode Go, OpenRouter e outros provedores (#205).

## v1.3.3 - 2026-10-22

Adicionada a configuração de horário de 12/24 horas, anexos do Office em formatos legados e o recolhimento de colagens longas, com rolagem mais suave no celular, compactação mais estável e amplas correções em salas e bots.

### Novos recursos

- **Formato de hora** — Adicionado Configurações → Geral → "Formato de hora" (celular: Configurações → Exibição) para mostrar horários como Sistema, 12 horas ou 24 horas.
- **Anexos do Office legados** — Adicionado o envio de arquivos `.xls`, `.doc` e `.ppt`; eles são convertidos pelo LibreOffice quando o recurso do Office está instalado (#163).
- **Colagens longas** — Adicionado o recolhimento de textos colados com mais de 1.000 caracteres no campo de mensagem e de mensagens enviadas com mais de 20 linhas atrás de "Ver mais" (#186).
- **Todos na sala** — Adicionado `@all` para mencionar todos os membros da sala e a possibilidade de chamar um membro da sala a partir de outra sessão para contatá-lo (#164, #180).
- **Nova tarefa sem projeto** — Adicionado `Ctrl+Alt+N` para abrir uma nova tarefa que não esteja vinculada a um projeto (#185).
- **Todas as contas de uso** — Adicionada a expansão de todas as contas conectadas no painel de uso e na barra lateral de atividades.
- **Entrada de imagens por modelo** — Adicionada a opção Auto/Ativado/Desativado em "Entrada de imagens" para cada modelo de provedor personalizado (#191).
- **Barra de metas** — Adicionados um anel de progresso, uma barra compacta apenas com contagem e uma confirmação de interrupção em linha à barra de metas.

### Alterações

- A lista de sessões foi alterada para ocultar subagentes e sessões arquivadas; sessões ociosas de subagentes são arquivadas após 3 dias e excluídas após 30 (#165).
- A alteração do modelo de um bot passou a ser aplicada aos seus chats abertos a partir do próximo turno (#166).
- As aprovações de bots passaram a ser solicitadas apenas nos próprios chats do bot, com os membros da sala seguindo as regras do seu chat principal (#167).
- O visual de Mixy foi alterado para ambas as orelhas caídas e uma cauda grossa com ponta mais clara.
- A posição do bot principal foi alterada para um único menu suspenso em Configurações, adicionou-se um posicionamento livre e sua foto enviada passou a ser exibida (#178, #179).
- As sessões de agentes na barra lateral foram alteradas para mostrar apenas o nome do modelo, e a sessão de tarefa de um bot para ser exibida como um único cartão de resultado.
- As respostas de código passaram a aparecer palavra por palavra, com os grupos de ferramentas concluídos nomeados no passado e a linha de status no final.
- Os provedores personalizados passaram a exibir o nome registrado nos seletores de modelos, no uso, nos fluxos de trabalho e nos avisos.
- Conectores com várias contas, como três contas do Gmail, passaram a ser exibidos como uma única linha e um único ícone.
- O toque em uma notificação foi alterado para abrir a sessão na sua mensagem mais recente.
- As abas do navegador no celular passaram a se conectar diretamente em vez de exibir o guia Adicionar à tela inicial.
- O ícone de notificação do Android foi alterado para o símbolo do Mixdog.

### Correções de bugs

- Corrigida a rolagem para cima no celular que parava no meio ou pulava quando mensagens mais antigas eram carregadas.
- Corrigidos toques e arrastes que não chegavam ao painel do navegador ao usar o Mixdog remotamente de um iPhone ou iPad.
- Corrigida a perda de relatórios de agentes, resultados de ferramentas e ferramentas MCP tardias após a compactação de uma conversa.
- Corrigida a conversa que parava de acompanhar uma resposta longa ou cancelava o acompanhamento ao tocar no texto.
- Corrigido o ponto de não lido que permanecia em um chat que estava sendo lido em um painel lateral.
- Corrigida a edição de uma mensagem anterior que perdia seus anexos e reversões que ignoravam o histórico posterior (#186).
- Corrigidas conversas abertas que não reconheciam agentes habilitados ou desabilitados (#184).
- Corrigidas respostas que paravam no limite de saída e um avaliador de esforço de raciocínio com falha que continuava quebrado (#183).
- Corrigido um bot removido que continuava suas atividades em salas e conversas (#180).
- Corrigidos bots que contornavam o limite de bot para bot passando por tarefas em segundo plano.
- Corrigido um backup de configurações com falha que descartava backups íntegros prematuramente (thanks @22nsuk).
- Corrigido o Windows Computer Use que perdia elementos de tela durante uma captura (#173, thanks @22nsuk).
- Corrigida a ordenação de memória que rejeitava respostas do classificador que listavam intervalos de linhas (#170, thanks @134634623).
- Corrigido o preparo (staging) de alterações do Git em arquivos que não estão em UTF-8 (#177).
- Corrigido o mascote que não aparecia quando sua imagem não possuía dimensões.

## v1.3.2 - 2026-10-21

Adicionados temas e skins com foto, a sobreposição do bot principal e a troca de workflow e modo de delegação no meio da conversa, com assinatura de código no Windows e amplas correções em compactação, aprovações e anexos.

### Novos recursos

- **Temas** — Adicionado Configurações → Tema para escolher Sistema, Escuro ou Branco, uma das quatro skins com fotos animadas, uma foto própria ou um vídeo curto, além da fonte e tamanho do texto em uma única tela.
- **Sobreposição do bot principal** — Adicionado o bot principal posicionado acima do campo de mensagem do aplicativo para PC, exibindo respostas em um balão que pagina sozinho as respostas longas; clique nele para enviar uma mensagem ou clique com o botão direito para tamanho, fixação de posição e configurações. Escolha em Configurações → Bots.
- **Modelos substitutos** — Adicionados modelos substitutos ao Lead, ao bot principal e aos perfis de bots, migrando para o próximo modelo quando um atinge seu limite de uso.
- **Troca de workflow e delegação** — Adicionada a alternância de workflow e modo de delegação a partir do menu de modelos durante uma conversa; aplica-se a partir do próximo turno somente àquela conversa.
- **Compactação inteligente** — Adicionado Configurações → Contexto → "Modelo de resumo de compactação" com Inteligente, Maintainer ou Modelo da conversa. Inteligente é o padrão.
- **Base de raciocínio automático** — Adicionado Configurações → Geral → "Base de raciocínio automático" para escolher o nível em torno do qual Auto trabalha.
- **Geração de imagens** — Adicionada a geração de imagens no Studio com modelos de imagem do OpenRouter e NanoGPT.
- **Posição do painel lateral** — Adicionada opção em Configurações → Geral para posicionar o painel lateral à direita, inferior ou automaticamente.
- **Layout da página de bots** — Adicionado o recurso de arrastar bots para reordená-los, exibir ou ocultar o bot principal, bots, salas e agentes no menu `…`, além de um local unificado para tarefas em execução.

### Alterações

- O instalador e o aplicativo para Windows agora têm assinatura de código, reduzindo avisos de segurança do Windows e falsos positivos de antivírus.
- As aprovações do browser-use passaram de janelas do SO para cartões de aprovação no chat, e os uploads de arquivos agora também pedem confirmação.
- Os cartões de aprovação agora mostram o bot solicitante e uma pergunta de uma linha, são recusados em um clique e nunca são recusados sozinhos enquanto aguardam.
- As solicitações de aprovação dos subagentes agora também aparecem no chat principal, com "Abrir sessão" para ir direto até lá.
- Os perfis de bots agora listam itens definidos como "Permitir sempre" e permitem reverter cada um com "Pergunte novamente".
- Agendamentos e webhooks agora pedem confirmação uma vez ao serem salvos e não perguntam novamente durante a execução; pagamentos e exclusão permanente nunca rodam sem supervisão.
- Um telefone vinculado agora só pode restringir, nunca ampliar, as permissões e conectores dos bots.
- Um bot desativado permanece na página de bots como "Desativado" para que possa ser reativado, e pode ser ocultado da barra lateral separadamente (#153).
- Os subagentes agora são expandidos clicando no rosto ou com clique direito em "Mostrar subagentes" em vez de uma seta.
- O seletor de modelos removeu o interruptor de "Raciocínio automático" e passou a listar Auto no topo da lista de esforço.
- O seletor de modelos agora abre logo abaixo de sua linha, e os provedores personalizados exibem o nome que você definiu.
- Ajustadas as salas de bots para que conversem naturalmente em vez de concordarem entre si o tempo todo; sem um modelo Maintainer, cada bot mencionado responde uma vez.
- As mensagens entre bots agora exibem o bot remetente e o destinatário, com limite de ida e volta entre bots a três trocas.
- Notificações de resposta de bot no PC e no telefone agora usam o nome do bot ou da sala como título.
- O botão Git do compositor agora abre a aba Git, onde "Criar PR", "Confirmar · enviar" e "Confirmar" têm cada um seu próprio botão "Executar".
- O cartão de fim de tarefa agora mostra miniaturas apenas dos arquivos vinculados na resposta ou abertos no painel lateral.
- Ajustada a rolagem para que a visualização se mova apenas quando você rolar e volte a seguir novas respostas assim que alcançar o fim; respostas longas que chegam de uma só vez começam a partir de sua primeira linha.
- Um servidor MCP lento atrasa a primeira resposta em no máximo 3 segundos; ferramentas conectadas posteriormente ficam disponíveis a partir do próximo turno.
- Alteradas as respostas em streaming para aparecerem em pequenos passos com um breve esvanecimento nas novas palavras, de modo que o texto não surja mais em blocos.
- Adicionada a fixação de agentes na página de bots pelo menu de clique com o botão direito, e "Manter agentes finalizados" no menu `…` por 1 hora, 1 dia, 7 dias ou Para sempre.
- Adicionado "Ilimitado" à limpeza automática de sessões ociosas.
- Ajustada a linha de tokens e custo na janela do agente para reservar seu espaço desde o início, evitando deslocamentos visuais.
- Ajustadas as orientações da ferramenta setup para que a IA possa definir a linha de acionamento (`when_to_use`) ao criar ou editar uma habilidade.

### Correções de bugs

- Corrigidos chats da Anthropic com imagens grandes ou PDFs que falhavam repetidamente com "attachmentReference: Extra inputs are not permitted".
- Corrigido o anexo de vários PDFs que bloqueava o chat por exceder o contexto; anexos grandes permanecem neste PC e apenas as partes necessárias são lidas (#150).
- Corrigido texto formatado copiado do Word, Excel ou navegador que era anexado como imagem (#135).
- Corrigidos anexos não enviados que desapareciam após visitar outra sessão (#139).
- Corrigido o modelo e o esforço de raciocínio do Lead que mudavam sempre que uma nova tarefa era aberta (#149).
- Corrigido o Claude Opus 5.5 que respondia em inglês em vez de coreano ao final de tarefas longas; as respostas finais do Lead e dos bots agora chegam em coreano.
- Corrompimento de arquivos de configuração e de conta após desligamento forçado com perda de logins e ajustes corrigido; agora são restaurados a partir da última cópia em bom estado (#151).
- Corrigida a criação ou edição de arquivos em pastas de sincronização como NAVER MYBOX que falhava com EPERM (#138).
- Corrigida a lista de modelos que permanecia vazia após o login no OpenCode Go (#141).
- Corrigida a instalação interrompida do motor code-tidy que travava sem reinstalar; agora relata a falha e reinstala por motor (#152).
- Corrigido o salvamento de provedor personalizado com lista de modelos lenta que falhava por tempo limite.
- Corrigida a inicialização de uma nova tarefa que retornava a uma tela em branco.
- Corrigida a lista de subagentes concluídos que desaparecia após reiniciar o aplicativo ou o serviço em segundo plano.
- Corrigidos subagentes em tarefas delegadas pelo bot principal que reportavam uma resposta intermediária como resultado antes de concluir.
- Corrigidas tarefas aguardando aprovação exibidas como travadas ou cortadas por tempo limite.
- Corrigidos subagentes que seguiam as configurações de contexto, esforço de raciocínio e velocidade do chat principal, ignorando a configuração do Maintainer.
- Corrigida resposta longa que chegava de uma só vez e parecia em branco e esmaecida por um momento.
- Corrigida entrada em fila interrompida que voltava a rodar após a recuperação (#142, thanks @22nsuk).
- Corrigidos trabalhos de shell cuja saída nunca foi confirmada que eram tratados como concluídos (#133, thanks @22nsuk).
- Corrigidas tarefas em execução que perdiam sua proteção quando o registro do workspace estava danificado (#117, thanks @22nsuk).
- Corrigidos modelos do Cursor que perdiam IDs de chamadas de ferramenta e transferências travadas de ferramentas que nunca terminavam (#156, thanks @22nsuk).
- Corrigido o indicador de digitação que nunca terminava em salas de bots e mensagens enviadas no meio de uma resposta que sumiam.
- Corrigido o aviso "results omitted" que não aparecia no chat do bot quando muitos resultados de rotina se acumulavam.
- Corrigida a contagem de não lidos da lista de bots que também contava chamadas de ferramentas.
- Corrigidos avisos de conclusão de outras sessões que não apareciam enquanto o app estava visível.
- Corrigida a lista de sessões que saltava em celulares quando sua ordem mudava durante a rolagem, e painéis de configurações no iPhone que não fechavam ao tocar fora.
- Corrigidos links de e-mail em respostas que não faziam nada ao serem clicados.
- Corrigidos os hooks PreToolUse sendo ignorados em sessões reabertas posteriormente, como no turno de acompanhamento de um agente (#161).
- Corrigido o login do GitHub travando em "Iniciando login no GitHub…" (#162).
- Corrigido o esforço de raciocínio ainda exibindo Auto após escolher outro (#131).
- Corrigido o botão de tela cheia de vídeos no painel lateral que não fazia nada (#160, thanks @Deno2026).
- Corrigido o aplicativo exibindo "Object has been destroyed" quando sua janela era fechada com a sobreposição do bot principal ativada.
- Corrigido um comando Git lento que fazia o aplicativo se reconectar ao seu serviço em segundo plano e perder brevemente as atualizações da sessão ao vivo.

## v1.3.1 - 2026-10-20

Um patch de estabilização para problemas encontrados desde a versão 1.3.0, com um avaliador de esforço de raciocínio atualizado.

Pedimos desculpas pelo fato de a atualização 1.3.0 ter redefinido dados de fluxo de trabalho para alguns usuários.

### Alterações

- Alteradas as mensagens enviadas durante uma tarefa em andamento para aparecerem no chat imediatamente, com **Enviar agora** até serem lidas; a fila acima do compositor foi removida.
- Alterados os cartões de aprovação para ações externas para aparecerem apenas quando um bot envia, publica ou exclui; as sessões de código não perguntam mais.
- Alterados o bot representativo e o Lead para manterem modelos separados, e enviar sem um modelo abre o seletor de modelos em vez de escolher um automaticamente.
- Alterados os bots e agentes para repassarem anexos e arquivos gerados ao transferirem tarefas entre si.
- Alterados os cartões de visualize para um cartão por tarefa, reunindo as páginas abertas como miniaturas.
- Alteradas as caixas de diálogo de confirmação, como exclusão, do padrão do Windows para caixas que combinam com o tema do app.
- Removidos o seletor de modelos e o indicador de contexto do compositor das salas de bots.
- Alterado o GitHub para não ser mais um conector; ele agora usa diretamente a GitHub CLI conectada.
- Ajustados os avisos de erro para fornecerem um erro claro em vez da mensagem bruta quando um modelo estiver indisponível ou uma chave for inválida.
- Ajustados os estilos de saída para que as respostas escolham parágrafos, tabelas ou listas adequados ao conteúdo.
- Alterado o tok/s do compositor para contar a espera pelo primeiro token, correspondendo à janela de Uso.
- Alterado o esforço de raciocínio automático para usar o avaliador de raciocínio automático v7, que concorda com as avaliações de referência com mais frequência que a v6.

### Correções de bugs

- Corrigida a falha ao salvar opções de modelo do Lead com "model selection contains an unsupported field" (#132).
- Corrigidas as falhas nos chats de bots com "provider message prefix changed outside compaction".
- Corrigido o modelo do Lead vazio após atualizar para a 1.3.0; ele agora assume o modelo usado pela última vez em uma nova tarefa, e os bots mantêm o modelo com o qual conversaram.
- Corrigidos agentes personalizados antigos aparecendo como bots após atualizar para a 1.3.0.
- Corrigida a personalidade do bot representativo vazando para sessões de código.
- Corrigido o bot representativo não reportando de volta após transferir trabalho para outra sessão; os relatórios agora continuam após reiniciar.
- Corrigidas as sessões de tarefas de agentes criadas pelo bot representativo que abriam com um modelo vazio ("Selecionar modelo").
- Corrigida a alternância para a página Bots que substituía a área principal pelo chat do bot representativo.
- Corrigido o compositor não aceitando entrada após excluir uma sala de bots.
- Corrigidos os agentes que não avançavam para o próximo modelo quando o primeiro atingia seu limite de uso.
- Corrigido o carregamento infinito no telefone quando o PC conectado estava desligado; agora informa que não foi possível conectar e permite tentar novamente (#134).
- Corrigida a rolagem no telefone travando ou saltando enquanto mensagens anteriores eram carregadas.
- Corrigida a abertura lenta do painel visualize no telefone.
- Corrigida a falha do Gemini 4 Argon com 404 ao fazer login com Antigravity.

## v1.3.0 - 2026-10-20

Adicionado um sistema de bots, suporte a mais conectores, incluindo o Gmail com senha de app, e mais estabilidade no cliente.

### Novos recursos

- **Chats de bots** — Adicionados chats de bots em estilo mensageiro com conversas principais persistentes, perfis de bot personalizáveis e o bot representativo padrão Mixy.
- **Salas em grupo** — Adicionadas salas em grupo onde vários bots colaboram, com menções `@`, anexos encaminhados aos bots mencionados e orquestração leve com supervisor usando o modelo Maintainer.
- **Cartões de aprovação para ações externas** — Adicionados cartões de aprovação para envio de mensagens, e-mails, publicações, pagamentos e exclusões, exibindo detalhes exatos antes de qualquer execução.
- **Rotinas nos chats de bots** — Adicionada a execução de agendamentos e webhooks como mensagens dentro do chat do seu bot responsável.
- **Guia de configuração** — Adicionado um guia de configuração inicial com recomendações de modelos por função e detecção do plano de assinatura.
- **Conectores** — Adicionados conectores para serviços externos, incluindo o Gmail com senha de app, para que os bots trabalhem com suas contas.

### Alterações

- Alterado o compositor no PC para uma barra de entrada de linha única que se expande com mensagens mais longas.
- Alteradas as listas longas de sessões e transcrições extensas para rolarem de forma mais suave.
- Alteradas as visualizações de diferenças da sessão para recolher linhas não modificadas e remover avisos de arquivos ausentes.
- Alteradas as atualizações do app para celular para serem baixadas em segundo plano, com status em Configurações e na barra de atividades.
- Ajustado o painel lateral visualize para alargar no mesmo intervalo do painel do navegador.
- Alteradas as rotinas para dispensar campos próprios de modelo e fluxo de trabalho e usar as configurações do bot responsável.

### Correções de bugs

- Corrigida a rolagem da transcrição no celular travando quando uma palavra em streaming terminava de esmaecer durante um arrasto.
- Corrigidas mensagens na fila e seus anexos perdidos ou ignorados após reiniciar (#119, thanks @22nsuk).
- Corrigidas configurações restauradas de um backup antigo quando dois salvamentos ocorriam no mesmo instante (#120, thanks @22nsuk).
- Corrigidos comandos de shell finalizados com processos filhos ainda em execução após falha ao iniciar ou cancelamento (#124, thanks @22nsuk).
- Corrigida a busca listando o mesmo arquivo duas vezes com grafias de caminho diferentes (#118, thanks @22nsuk).
- Corrigido o salto da lista de sessões ao favoritar, desfavoritar ou excluir uma sessão (#129, thanks @oh1701).

### Outros

- Atualizadas as traduções da interface em todos os idiomas suportados.

## v1.2.6 - 2026-10-18

O desktop agora consome menos recursos quando ocioso e alterna entre sessões mais rapidamente, comandos de shell passam para o segundo plano após 60 segundos, e o gerenciamento de modelos e o login no OpenCode Go são novidades.

### Novos recursos

- **Gerenciamento de modelos** — Adicionada uma página em Configurações para favoritar e ocultar modelos, além de um menu de clique com o botão direito no seletor de modelos.
- **Login no OpenCode Go** — Adicionado o login no OpenCode Go com sua conta OpenCode; substitui a antiga chave de API.

### Alterações

- Alterado o desktop para usar menos CPU quando ocioso e alternar entre sessões mais rapidamente.
- Alterado o shell para mover comandos para o segundo plano após 60 segundos; os avisos de conclusão agora incluem o código de saída e a saída.
- Alteradas as listas de provedores para mostrar por que os modelos falharam ao carregar em vez de uma lista vazia, e adicionado um link para a chave de API nos provedores conectados.
- Alterado o arquivamento ou a exclusão de uma sessão ocupada para solicitar confirmação primeiro (#109).
- Alteradas as respostas para ficarem mais concisas e agruparem resultados, causas e decisões; tabelas agora quebram linhas em vez de rolar horizontalmente.

### Correções de bugs

- Corrigido o backend travando sob alta carga de agentes e reiniciando a si mesmo, o que interrompia os agentes em execução.
- Corrigido o cancelamento deixando processos filhos e servidores em execução (#115).
- Corrigido o texto colado sendo difícil de ler ou editar quando longo (#110), e a digitação de uma `/` simples no compositor (thanks @oh1701).
- Corrigida a caixa de diálogo de confirmação do shell empurrando seus botões para fora da tela (#114) e pastas `.git` vazias bloqueando tarefas (#108).
- Corrigido o total de uso dos agentes deixando de fora agentes encerrados (#99, thanks @22nsuk).
- Corrigida a perda de anexos durante o carregamento e um agente com falha marcando toda a aba de sua sessão como com falha.
- Corrigido cada turno falhando com "Workspace activity cannot be verified" após uma falha danificar o registro do espaço de trabalho.
- Corrigidos tempos de espera de contas expiradas não tentando novamente (#106), backups de configurações perdendo os originais (#105) e histórico de uso ilegível bloqueando os totais (#103), thanks @22nsuk.

## v1.2.5 - 2026-10-18

Os telefones agora se conectam mais rápido e sem pop-ups, o desktop não fica mais lento quando muitos agentes são executados e as respostas em streaming aparecem com mais suavidade.

### Alterações

- Alteradas as conexões do telefone para reconectar automaticamente sem pop-ups ou contagens regressivas; um ponto pequeno aparece apenas durante uma desconexão longa.
- Alteradas as respostas em streaming para aparecerem palavra por palavra com um fade suave, sem saltos de Markdown incompleto; blocos de código aparecem com seu conteúdo.
- Alterado o status do agente para mostrar Done até você abrir o resultado, e depois Idle.
- Alterado o menu de ramificação para abrir a partir de um botão `…` ou clique com o botão direito; em telefones, pressione e segure uma ramificação.
- Alteradas as páginas de visualize em telefones para abrirem diretamente sem a solicitação Run, assim como no desktop.
- Ajustados o painel de uso e o resumo da ilha do compositor para manter sua altura enquanto os valores carregam.
- Alterado o código QR de instalação do Android para baixar o aplicativo diretamente.

### Correções de bugs

- Corrigidas mensagens enviadas e respostas que não apareciam na conversa após o aplicativo reiniciar até que fosse reaberto (#113, thanks @oh1701).
- Corrigido o desktop pausando cerca de um segundo por vez quando existiam mais de 256 sessões de agentes.
- Corrigidas solicitações de telefones aguardando leituras lentas de uso e do Git no desktop.
- Corrigidos telefones desconectados enquanto o desktop estava ocupado e a primeira conexão após abrir o aplicativo demorando mais de 10 segundos.
- Corrigidos telefones que permaneciam em "Allowed. Connecting…" indefinidamente ou exibiam "Request expired" após o PC ter aprovado.
- Corrigido o telefone solicitando aprovação novamente ao iniciar após perder seu login salvo.
- Corrigidos telefones que pareciam conectados enquanto o PC reiniciava, com todas as mensagens expirando por tempo limite.
- Corrigidos telefones pareados desconectados em definitivo quando o PC falhava ao ler sua identidade de conexão.
- Corrigida uma verificação lenta de caminho de arquivo que travava todas as outras solicitações do telefone.
- Corrigida a rolagem para cima em conversas longas travando enquanto mensagens antigas eram carregadas (#104).
- Corrigida a conversa sendo puxada de volta para baixo ao rolar para cima no celular durante uma resposta em streaming.
- Corrigidos ícones sobrepostos em cartões de arquivo e avisos repetidos de falha no download.

## v1.2.4 - 2026-10-17

Atualização com controle de sessões de agentes e atribuição de modelos de fallback, preparação automática de worktrees, otimização de saída do harness e melhorias gerais de desempenho.

### 1. Melhorias no harness: redução de saída, estilos mais limpos e estabilização geral

- Os relatórios de conclusão do agente e os cartões de perguntas foram simplificados, reduzindo as saídas das ferramentas Git, busca e GitHub para economizar tokens.
- A limpeza de processos de shell em segundo plano e ferramentas externas foi estabilizada, melhorando os critérios de detecção de agentes sem resposta em tarefas longas.

### 2. Melhorias na geração de mídia

- A estabilidade da geração de imagens do ChatGPT foi aprimorada, adicionado suporte a fundos transparentes e permitida a fixação de modelos preferidos por tipo de mídia.

### 3. Atribuição de modelos de fallback para agentes

- Adicionado suporte a modelos de fallback que entram em ação na ordem caso o modelo principal falhe, além de permitir especificar um modelo diretamente ao iniciar subagentes (#86).

### 4. Melhorias em worktrees

- Adicionadas instalação automática de pacotes e configuração do ambiente ao criar uma nova worktree, melhorando a capacidade de resposta do menu de branches.

### 5. Estabilização de chamadas de ferramentas por provedor

- Corrigidos erros no processamento de pensamento do Claude no Antigravity, adicionada a exibição de uso e reforçada a confiabilidade de raciocínio e chamadas de ferramentas em gateways personalizados (#79, #94, thanks @22nsuk and @sukjong2002).
- A conexão e as novas tentativas do Antigravity foram estabilizadas, e a execução de ferramentas em ambientes compatíveis com Cursor e OpenAI foi melhorada.
- Adicionada a capacidade de verificar o status dos provedores registrados no PC diretamente das janelas SSH remotas (#77, thanks @22nsuk).
- Melhorada a compressão de solicitações da Anthropic e do ChatGPT com fallback seguro para acelerar o início das respostas.

### 6. Renovação do gerenciamento de sessões de agentes

- Ajustado para que agentes concluídos permaneçam no painel por 1 hora, restaurando o resumo de contagem de tarefas por status e os avisos de espera.

### 7. Gerenciamento de sessões pelo agente principal

- Adicionada a capacidade de o agente principal visualizar a lista e os conteúdos de outras sessões e gerenciá-las diretamente enviando mensagens, cancelando ou excluindo sessões.

### 8. Otimizações de desempenho remoto e no desktop

- As reconexões remotas agora recuperam rapidamente apenas o conteúdo perdido, melhorando a fluidez das respostas e a velocidade de troca de sessão em dispositivos móveis.
- Permitida a reabertura direta das 2 sessões mais recentes no celular e corrigido o travamento na tela de inicialização.
- Painéis do desktop, barra lateral, alternância de sessões, editor e telas de configurações foram otimizados para abrir mais rápido e com mais fluidez.

### 9. Melhorias no download do app remoto

- Adicionado download em ZIP de pastas excluindo arquivos desnecessários no web app remoto e ampliada a variedade de arquivos que podem ser baixados por links na conversa.
- Melhorados o salvamento de arquivos no celular e a ativação de notificações (o salvamento de arquivos no Android/iOS se aplica após a atualização do app).

### 10. Outras correções de bugs e pequenas melhorias

- Removidos limites de chamadas e taxa de requisições nas conexões de modelos remotos via SSH (#101).
- Retomada automática de Goals pausados assim que o uso for redefinido e corrigidos vários bugs no painel de alterações e na exibição de status dos comandos.
- Corrigido o bloqueio do navegador interno no login do Google e nas verificações antibot (#102).

## v1.2.3 - 2026-10-16

Desde o lançamento, muito mais pessoas do que esperávamos estão usando o Mixdog, e somos imensamente gratos. Algumas partes ainda estão instáveis, e estamos corrigindo-as o mais rápido possível. Seus problemas relatados e pull requests moldaram grande parte desta versão. Se algo der errado, avise-nos em **Configurações → Sobre → Feedback**.

Novo no raciocínio automático? Um pequeno modelo avaliador no seu PC escolhe o quanto o modelo deve pensar para cada mensagem e etapa. Veja como funciona e o desempenho no Terminal-Bench 2.1 em [Esforço de raciocínio automático](https://github.com/tribgames/mixdog/blob/main/docs/auto-reasoning-effort.md).

Adicionada a movimentação de um chat para um worktree a partir da ilha do compositor, streaming de texto mais suave e um serviço em segundo plano mais rápido e confiável.

### Novos recursos

- **Worktrees a partir da ilha** — Adicionado um segmento de ramificação à ilha do compositor que move um chat para um worktree, mantendo ou deixando alterações não confirmadas.
- **Cartões de perguntas** — Adicionado um cartão para perguntas que um agente faz a você, no aplicativo desktop e na TUI.
- **`/btw`** — Adicionado `/btw` para fazer uma pergunta rápida sem interromper a tarefa atual.
- **Ferramenta de sessão** — Adicionada uma ferramenta que permite ao agente renomear, compactar, bifurcar e mover a sessão atual (#14, thanks @hyeon1035298).
- **Vários PCs no Android** — Adicionada a alternância entre até 16 PCs salvos no aplicativo Android (#83, thanks @yupguni).
- **Recuperar edições interrompidas** — Adicionado um painel de recuperação que mostra edições de arquivo interrompidas por falhas e as restaura ou descarta com segurança (#60, thanks @22nsuk).

### Alterações

- Alteradas as respostas em streaming para aparecerem suavemente à medida que são escritas, em vez de rajadas linha por linha.
- Alteradas a saída, novos chats e o painel Alterações para responderem muito mais rápido.
- Alterados os esquemas de ferramentas MCP para serem convertidos para cada provedor, para que ferramentas que funcionam em outros aplicativos funcionem no Mixdog; uma ferramenta com falha é ignorada com um aviso.
- Alterados os totais de uso para permanecerem ocultos quando um provedor não relatar o uso de cada chamada (#90, #91, thanks @22nsuk).
- Alterada a migração de alterações para um worktree para recusar arquivos ocultados pelo Git no status, evitando perda de edições.
- Alterados os backups de configurações para permanecerem em cada perfil, de forma que as configurações de um perfil nunca sejam sobrescritas por outro.
- Alterada a faixa de versões do Visualize para um menu Versões, adicionando renomeação de abas com clique duplo e destaque de comandos com barra.
- Alterados os ícones de provedores para os logotipos oficiais.
- Alterado o raciocínio automático para também funcionar nas rotas de login do ChatGPT.

### Correções de bugs

- Corrigida a falha com HTTP 400 em modelos Claude no Antigravity devido a esquemas de ferramentas (#80, thanks @ProofPage).
- Corrigido o botão Nova ramificação no chat que não fazia nada (#85, thanks @oh1701).
- Corrigidos agentes recém-iniciados que não viam as ferramentas MCP em seu primeiro turno (#88, thanks @oh1701).
- Corrigido o congelamento do serviço em segundo plano ao excluir sessões e o retorno de sessões excluídas ou de suas abas.
- Corrigido o banco de dados que às vezes permanecia aberto após sair do aplicativo.
- Corrigida a primeira mensagem após trocar o modelo de um chat que falhava com "Session state changed unexpectedly".
- Corrigido o botão Voltar do Android que não fechava o painel lateral direito.
- Corrigido o nome da ramificação na ilha que aparecia com atraso e deslocava o layout, e linhas de shell que piscavam ao concluir um comando.
- Corrigido o painel lateral que permanecia aberto após fechar sua última aba e o painel Visualize que permanecia recolhido ao abrir um elemento visual.
- Corrigidos os seletores de provedores de desenvolvedor que apareciam desativados após ativá-los e erros de provedores personalizados que mostravam mensagens internas.
- Corrigido o salto da transcrição quando o compositor alterava sua altura.

### Outros

- Corrigido um erro de compilação do desktop (#89, thanks @22nsuk).

## v1.2.2 - 2026-10-14

Adicionados login OAuth explícito para MCP, troca de modelo no local e um banner de cota de linha única.

### Novos recursos

- **Login no MCP** — Adicionado login OAuth explícito para servidores MCP com status, diálogo de login compartilhado, colagem remota e comandos TUI (#74, thanks @oh1701).
- **Trocar modelo no local** — Adicionada a troca de modelo de um chat sem iniciar uma nova sessão, e Bifurcar no menu da sessão (#73, #52, thanks @grapefruit0205).
- **Banner de cota** — Adicionado um banner de linha única acima do compositor quando um limite é atingido; Continuar reserva a próxima execução para o horário de redefinição.
- **Menu de arquivos** — Adicionada uma contagem de arquivos na ilha que rastreia alterações não confirmadas da sessão, com Ver alterações e Excluir histórico.
- **Tamanho do texto do chat** — Adicionada uma configuração de tamanho de texto do chat por dispositivo.

### Alterações

- Alteradas as novas tentativas de provedores para seguir os limites e tempos de espera próprios de cada provedor, exibindo a espera restante com opção de cancelar.
- Alteradas as mensagens de erro para indicar a causa e o próximo passo, ocultando Tentar novamente quando tentar novamente não ajudar.
- Alterados os comandos de shell para permanecer em primeiro plano por 10 segundos por padrão, até 30 segundos, antes de irem para o segundo plano.
- Ajustados o aplicativo desktop, o raciocínio automático e o serviço em segundo plano para consumir menos sondagem, renderização e memória em sessões longas.

### Correções de bugs

- Corrigido o congelamento de um a dois segundos do serviço em segundo plano a cada 30 minutos.
- Corrigida a perda de avisos de conclusão de agentes quando um turno que já possuía saída era cancelado.
- Corrigida a ilha do compositor exibindo agentes em execução como ociosos ou concluídos.
- Corrigido o travamento na troca de sessões ao aguardar varreduras de alterações de outras sessões.
- Corrigidos os diálogos de página do navegador saindo do painel, a confirmação de saída não concluindo e o não funcionamento dos atalhos de cópia do navegador.
- Corrigida a falha no cache de prompts em provedores Responses personalizados e projetos de sessão herdados que não correspondiam à barra lateral (#70, #75, thanks @sukjong2002).
- Corrigidas a oscilação de tabelas em streaming, a oscilação da transcrição durante a execução de um turno e a permanência do cartão de cota após a troca de provedores.

### Outros

- Removidos helpers não utilizados (#67, thanks @22nsuk).

## v1.2.1 - 2026-10-14

Adicionada a importação de conversas do Codex e do Claude Code, o provedor Command Code e menções de skills com `$`, e corrigida a observação de entrada do Computer Use, scripts de skills, raciocínio automático e vários problemas de sessão.

### Novos recursos

- **Importação de conversas** — Adicionado Configurações > Geral > Importar conversas para trazer chats do Codex e do Claude Code deste PC para o Mixdog.
- **Command Code** — Adicionado o Command Code como provedor que faz login com sua conta do Command Code.
- **Políticas de troca de conta** — Adicionadas as opções Manualmente, Trocar no limite e Mais folga primeiro para provedores com várias contas.
- **Menções de skills com `$`** — Adicionado `$` no compositor e na TUI para escolher uma skill e aplicá-la à mensagem.
- **Barra de uso de 5 horas** — Adicionada uma opção no menu de uso que exibe uma barra de 5 horas ao lado do período mais longo na barra lateral (#66).
- **Cartões de feedback de visualização** — Adicionados cartões no compositor para fixações, seleções e ajustes em fila, além de marcadores em imagens, vídeos e áreas.
- **Fechar Goal** — Adicionado um botão para dispensar um Goal concluído.

### Alterações

- Alterados os servidores MCP de plugins do Claude Code e Codex para conectar automaticamente sem etapa manual, e adicionado o carregamento de skills de plugins (#58).
- Alterada a lista de sessões para carregar a partir de banco de dados local e caches para abrir mais rapidamente.
- Alteradas as skills em servidores SSH para rotear chamadas de modelo pelo seu PC, dispensando credenciais no servidor.
- Alteradas as menções de arquivo com `@` para listar pastas primeiro.
- Alterados os ícones de Muse Code e MiMo para seus próprios ícones.
- Alteradas as miniaturas de imagens enviadas para carregar como prévias reduzidas no PC e celulares pareados.
- Ajustados o carregamento de ferramentas MCP, buscas de arquivos e salvamento de contas para não travar o serviço em segundo plano em sessões longas.
- Ajustada a marca de progresso do Goal para exibir sempre cinco células.
- Ajustada a ilha do compositor para ficar 12px acima do cartão de prompt e restauradas as linhas de atividade de ferramentas para 14px.

### Correções de bugs

- Corrigido o Computer Use indisponível com "foreground input observation is unavailable"; entradas perdidas contam como do usuário, a observação recupera sozinha e o diagnóstico informa a causa (#66).
- Corrigido o problema em que adicionar um servidor SSH no aplicativo instalado ficava indefinidamente em "Conectando…", empacotando o lockfile do servidor (#69, obrigado a @victorwon2001).
- Corrigido o problema em que os links do chat abriam o navegador interno em uma página `about:blank` em branco em vez do link (#63).
- Corrigidos scripts de skills incluídos, como o validador, falhando em algumas instalações e shells (#62).
- Corrigidas novas tarefas que lembravam fluxos excluídos para iniciarem no Default (#64).
- Corrigido o raciocínio automático que não se aplicava em rotas do Claude no 1.2.0 e um julgamento lento causando tempo limite nos seguintes.
- Corrigidos os provedores Gemini, Anthropic, OpenAI e compatíveis com OpenAI não listando modelos quando a chave era adicionada após o início.
- Corrigida uma segunda mensagem enviada logo após iniciar uma nova tarefa abrindo uma sessão separada.
- Corrigida a rolagem rápida para cima em celulares parando antes do fim e saltando para o topo no toque seguinte.
- Corrigido o editor de renomeação fechando imediatamente para sessões listadas na pasta do projeto e em Recentes.
- Corrigidas miniaturas exibindo a imagem errada em conversas restauradas com várias imagens.
- Corrigidos comandos de hook herdando configurações internas de runtime do Mixdog.
- Corrigidas execuções headless, como chamadas de modelo de scripts de skills, que não conseguiam usar Muse Code ou MiMo.
- Corrigido o diálogo de confirmação que não aparecia ao remover um servidor MCP ou plugin.
- Corrigida a falha de carregamento do runtime do ONNX em PCs com Windows sem o runtime do Visual C++, distribuindo esse runtime com o app.

### Outros

- Revisão de traduções em todos os 11 idiomas.
- Removidos helpers não utilizados e formatados testes desktop (#68, obrigado a @22nsuk).

## v1.2.0 - 2026-10-13

Esta versão introduz o painel de alterações e cartões de alterações por turno com controles de desfazer e reaplicar por turno, mantém o histórico anterior visível após a compactação e adiciona uma ferramenta integrada de visualização para maquetes interativas de interface e diagramas. Os fluxos de trabalho remotos são expandidos com conexões de servidor SSH, sessões isoladas de worktree do Git, gerenciamento de shells em segundo plano e downloads diretos de arquivos em telefones pareados. A interface também traz maior contraste, rolagem mais suave em dispositivos móveis e organização flexível de sessões.

### Novos recursos

- Após a compactação de uma conversa, as mensagens anteriores, cartões de ferramentas e diffs permanecem legíveis acima de um divisor "Conversa compactada" em vez de desaparecerem. Eles são mantidos apenas para exibição (nunca enviados ao modelo), recarregam ao rolar para cima após reiniciar, usam até cerca de 32 MB por sessão (com os mais antigos descartados primeiro), filtram valores confidenciais como o restante do histórico e são excluídos com a sessão; sessões continuadas vinculam o histórico em vez de duplicá-lo. Desfazer, reaplicar e tentar novamente não estão disponíveis para turnos anteriores à compactação.
- O novo painel de alterações oferece uma visualização contínua com rolagem dos diffs de todos os arquivos modificados e abas laterais: a aba "Alterações" exibe todos os arquivos, enquanto o clique em um arquivo em um cartão de turno abre apenas a aba correspondente. Funciona sem o Git usando os próprios registros de alteração da sessão, destaca sintaxe, quebra linhas longas sem rolagem horizontal, recolhe ou expande arquivos ao clicar na linha, abre arquivos em abas com `↗`, desfaz edições com `↶` e lista arquivos fora do projeto como somente leitura com o caminho completo na dica de ferramenta. Fechar a última aba fecha o painel.
- Um cartão de alterações sob cada turno exibe o número de arquivos modificados, um resumo de linhas diff com +N −N, um botão para visualizar alterações e a lista de arquivos editados.
- Os cartões de ferramentas reprojetados exibem a alteração feita por cada edição individual em vez do total acumulado do turno, renderizados na mesma visualização de diff do painel de alterações, e mostram adições e exclusões de linhas durante a execução da ferramenta.
- Uma ferramenta integrada de visualização gera maquetes de projeto e diagramas inline (Mermaid, SVG, ECharts, HTML e Markdown) em abas dedicadas do painel lateral. Você pode inspecionar elementos, capturar erros de página, deixar comentários com marcadores e seleções de dados para a próxima mensagem, comparar e restaurar versões e exportar designs para PNG ou PDF.
- As sessões de worktree do Git permitem trabalhar em ramificações isoladas sem alterar o ambiente de trabalho atual. Um seletor de ramificação acima do compositor permite escolher ou criar uma nova ramificação de worktree ao iniciar uma tarefa, com mesclagens protegidas que evitam resíduos de conflito.
- Conecte-se a servidores remotos via SSH em Configurações > Conexão. O Mixdog é instalado automaticamente no servidor, abre em sua própria janela com um painel de portas com encaminhamento de portas, navegação remota de arquivos e terminais, e redireciona chamadas de modelos pelo PC para que as credenciais nunca precisem ficar no servidor.
- Celulares pareados agora podem baixar e compartilhar arquivos produzidos pelo assistente e mídias geradas diretamente a partir de links no chat, com progresso de transferência, novas tentativas e cancelamento (salva em Downloads no Android e via folha de compartilhamento no iOS; com a próxima atualização do aplicativo Android ou compilação iOS) (#40). Os telefones pareados também ficam estritamente restritos a projetos registrados e arquivos produzidos naquela sessão.
- Comandos de shell em segundo plano podem ser interrompidos diretamente no aplicativo ou remotamente. Comandos finalizados permanecem listados até serem dispensados em vez de sumirem imediatamente, e o painel de tarefas no compositor se expande para mostrar comandos em execução ao lado de agentes com uso acumulado de tokens e chamadas de ferramentas.
- Mova uma sessão para outro projeto a partir do menu lateral ou arrastando e soltando sem mover a pasta no disco; sessões em subpastas e worktrees de um projeto são agrupadas automaticamente sob esse projeto.
- Os painéis laterais em celulares (navegador, terminal, alterações e pré-visualização) compartilham o mesmo cabeçalho do PC, com abas, menu para alternar painéis e botão de fechar. No navegador do celular, `+` abre uma nova aba no painel lateral dessa sessão, e as abas alternam e fecham exatamente como no PC (requer o aplicativo de PC atualizado).
- Imagens enviadas no chat mantêm miniaturas após reiniciar o app, e cartões de arquivos HTML e de visualização exibem uma pré-visualização visual real da página renderizada localmente em um ambiente isolado sem acesso à rede para arquivos dentro do projeto.
- O compositor lista agentes em execução no mesmo formato da janela de agentes e oculta automaticamente a seção de shell quando não há shells em segundo plano ativos.
- Fechar a última aba de terminal, navegador ou arquivo fecha automaticamente o painel lateral, e reabrir o terminal inicia uma nova aba limpa (baseado em #49 por @moveju112).
- Pastas de projeto e seções da barra lateral permanecem abertas por padrão e lembram seu estado recolhido, enquanto selecionar uma sessão em uma pasta recolhida a abre automaticamente. As sessões também podem ser reorganizadas arrastando ou ordenadas por atividade recente.
- O aplicativo Android agora pode verificar atualizações em segundo plano, baixar, verificar assinaturas e instalar novas versões diretamente (com a próxima atualização do aplicativo Android).
- O raciocínio automático agora pode ser configurado individualmente por rota de modelo nas configurações de rota e desativado para automações com `+noauto`. Em Configurações > Conexão, você também pode atribuir apelidos locais personalizados a dispositivos remotos pareados.

### Alterações

- Cores de destaque mais nítidas e maior contraste de texto; cabeçalhos de cartões de ferramentas e turnos usam cinza sutil com caixas apenas com contorno; código inline é exibido como blocos cinzas e citações com uma barra à esquerda; texto selecionado e números de linha de diff atendem ao contraste de 4.5:1 em ambos os temas.
- O menu lateral abre sem sombra e escurece a tela de fundo em 40%.
- O seletor de ramificação e worktree acima do compositor aparece apenas em projetos Git e antes do início da conversa.
- A contagem de arquivos alterados no compositor agora abrange toda a sessão em vez de ser redefinida após cada turno.
- O botão de visualização foi removido do cabeçalho do painel; visualizações abrem automaticamente ou a partir de seu cartão na conversa.
- O anel de contexto abre apenas com clique, não mais ao passar o mouse (#48).
- Em celulares, a tecla Enter insere uma quebra de linha; o envio é feito pelo botão.
- As mensagens esmaecem gradualmente sob o compositor em vez de serem cortadas de forma abrupta.
- Arquivos fora do projeto exibem seu nome com o caminho completo na dica de ferramenta em vez de um selo.
- Rolagem mais suave, especialmente no Android: a conversa é redesenhada no máximo uma vez por quadro, o indicador de carregamento é animado na GPU, a posição de rolagem é salva ao parar, toques não são mais bloqueados e o esmaecimento sob o compositor não redesenha a lista inteira.
- Chamadas de ferramentas MCP aplicam limites de tempo de execução (padrão de 120 segundos) sem travar ou repetir solicitações canceladas, relatam falhas de processos stdio com detalhes de erro e suportam paginação para listas extensas de ferramentas.
- Limpeza automática de sessões ociosas é executada antes que conclusões em segundo plano reativem a conversa.
- No macOS, a inicialização do aplicativo desktop anexa diretórios do Homebrew ao `PATH` sem descartar entradas existentes.
- O terminal remoto no celular inclui uma barra de teclas dedicada com modificadores e teclas de navegação (com a próxima atualização do aplicativo Android ou compilação iOS).

### Correções de bugs

- Tocar em um link no chat abria um navegador interno em branco; a página agora carrega corretamente e em celulares o painel do navegador abre em tela cheia (#41).
- O indicador de pensamento permanecia em inglês até o carregamento do idioma do aplicativo; a animação de brilho em celulares foi corrigida.
- O cartão de turno, o compositor e o painel de alterações podiam exibir números divergentes de arquivos modificados.
- A primeira rolagem para cima em conversas longas podia causar saltos visuais.
- Fechar a última aba do terminal criava uma nova aba indevidamente e piscava (#49).
- A leitura de arquivos não retorna mais conteúdo obsoleto nem informa intervalos de linhas que não foram realmente entregues, mesmo ao sobrescrever um arquivo grande no mesmo local com tamanho idêntico (#54, obrigado a @22nsuk).
- O salvamento de arquivos e a recuperação em lote mantêm a codificação do texto, rejeitam salvamentos com perda, protegem buffers modificados durante conflitos de leitura e rastreiam gravações em lote preservando permissões e maiúsculas/minúsculas de caminhos (#39, obrigado a @22nsuk).
- No macOS, `Cmd+Up` e `Cmd+Down` movem o cursor dentro de campos de texto em vez de acionar atalhos de navegação da área de trabalho.
- Arquivos de configuração e estado iniciados com uma marca de ordem de bytes (BOM) carregam corretamente sem falhas ou reinicializações.
- O login com a OpenAI preserva a lista completa de modelos disponíveis em vez de ocultar modelos indevidamente.
- No Linux, colar ou ler uma imagem causava o encerramento inesperado do serviço em segundo plano do Mixdog e cancelava o turno em execução; as imagens agora passam por uma compilação da biblioteca de imagens compatível com essa plataforma (#56, #57, obrigado a @cronoboris).
- Após um encerramento anormal do Mixdog (desligamento do Windows, instaladores, finalização pelo Gerenciador de Tarefas), o aplicativo podia falhar em todas as ações com o erro "daemon session endpoint is unavailable" e não exibir conversas até que um arquivo de bloqueio restante fosse removido; ele agora reconhece o bloqueio obsoleto e se recupera sozinho. Um arquivo ilegível na pasta temporária também não impede mais a inicialização do serviço em segundo plano e, quando ele ainda não consegue iniciar, os detalhes do erro mostram a causa real e a localização dos logs.

### Outros

- Revisão de traduções de termos novos e alterados em todos os 11 idiomas suportados.
- Publicação de dados brutos de avaliação para DeepSeek V4.1 Flash no Terminal-Bench em 89 tarefas comparando Mixdog com DSH (#43), e adição do perfil completo de avaliação do GPT-6.1 Sol.
- Ícones do aplicativo móvel atualizados para corresponder ao design em titânio da versão desktop (com a próxima atualização do aplicativo Android).

## v1.1.2 - 2026-10-12

O aviso "Novidades" agora aparece após uma atualização mesmo que o armazenamento local do app tenha sido perdido, espera até que a boas-vindas ou o tour inicial seja fechado e não reaparece após um downgrade.

O guia inicial não reaparece mais para usuários existentes após a perda do armazenamento local ou uma atualização do app.

O uso do Muse Code e do MiMo agora aparece em uma linha própria na barra lateral, em vez de ser exibido como Grok.

A velocidade Ultrafast é mostrada em laranja nos rótulos de modelo, incluindo as linhas de agentes no painel lateral.

Na ilha do compositor, clicar no segmento de arquivos abre a lista de arquivos alterados no painel lateral direito quando vários arquivos mudaram (com um único arquivo alterado, o diff dele continua sendo aberto). Os segmentos de agentes e shell também abrem suas listas no painel lateral, no formato da barra lateral Agentes e navegáveis pelo teclado.

As linhas de ferramentas não mostram mais o brilho em movimento durante a execução.

Adicionar um servidor MCP pela caixa de diálogo de adição agora o cria, e um nome que já existe é rejeitado em vez de sobrescrever o servidor existente.

No Linux, "Permitir" para o acesso de entrada do Computer Use agora verifica o acesso real a `/dev/uinput`, repara quando necessário e explica o que fazer se ainda falhar: sair e entrar novamente, adicionar seu usuário ao grupo `input` ou ativar o módulo uinput ausente (#32).

## v1.1.1 - 2026-10-12

Continuar uma sessão depois de trocar o modelo ("Continuar em <modelo>") e tentar novamente um turno com falha ("Tentar novamente") não falham mais com "submit options contains an unsupported field."

O Muse Code (Meta) está disponível como provedor por assinatura: entre com um código de dispositivo no navegador e veja seu uso contínuo e semanal diretamente no Mixdog.

O login do MiMo (Xiaomi) está disponível em Configurações → Opções do desenvolvedor, junto com Cursor e Antigravity (desativado por padrão).

A nova configuração "Arquivos de instruções" em Configurações → Geral pode incluir automaticamente nas novas sessões as regras de AGENTS.md / CLAUDE.md das suas pastas pessoais (~/.codex e ~/.claude) e da pasta do projeto. Escolha AGENTS.md, CLAUDE.md, Todos ou Desativado. Ela vem desativada por padrão; como esses arquivos são tratados como instruções confiáveis, ative-a apenas em repositórios em que você confia.

O Daybreak Blue agora é uma chave por rota em "Raciocínio automático" nos modelos compatíveis, de acordo com a lista de modelos do provedor. O modelo Blue separado foi aposentado, e as rotas existentes passam para um modelo compatível com o Blue ativado.

- O avaliador de raciocínio automático v6 é instalado automaticamente após a atualização. Ele é o EmbeddingGemma 2 ajustado exclusivamente para avaliar o esforço de raciocínio e avalia tanto solicitações quanto etapas de ferramenta dos agentes. Nos mesmos 12,029 itens reservados, é mais preciso que o Jev 1.13 (nível exato 78,5% contra 72,7%; dois ou mais níveis de diferença 0,6% contra 1,4%) e decide em cerca de 115 ms no seu PC. Detalhes: `docs/auto-reasoning-effort.md`

O raciocínio automático agora aparece como "Auto" em todo lugar onde modelo e esforço são exibidos, incluindo a barra lateral de agentes, os fluxos de trabalho, os agendamentos e os webhooks. A linha de status de trabalho mostra o esforço que o Auto realmente escolheu, traduzido para o seu idioma (por exemplo, "Pensando (medium)").

A ilha do compositor acima do campo de mensagem foi redesenhada. Os objetivos mostram um ícone de estado, indicadores de progresso por tarefa e "Em andamento"; agentes, shells e arquivos alterados são contados separadamente com ícones próprios; e os agentes aguardando sua aprovação exibem "Aguardando aprovação" e uma contagem "Precisa de você" em vez de parecerem ocupados. Clicar em um agente abre a sessão dele, o tempo decorrido do agente agora conta a partir do turno atual e não da criação, e a ilha permanece por um instante após o fim do trabalho em vez de piscar e sumir. O painel Agentes também marca os agentes que aguardam aprovação.

Suas próprias mensagens não mostram mais "deste PC"; a identificação do dispositivo aparece apenas em mensagens enviadas de outros dispositivos.

A janela de uso abre imediatamente com os últimos valores enquanto os números mais recentes são atualizados em segundo plano.

A atualização automática do macOS agora funciona. As versões anteriores não tinham o feed de atualização do macOS, então as instalações no Mac não conseguiam se atualizar sozinhas.

O aviso de novidades após a atualização não se perde mais caso não consiga aparecer; ele só é marcado como visto depois de realmente ter sido exibido.

A página de configurações de Conexão não "pula" mais ao abrir, e o botão "Usar" de "Créditos de reset" no celular ficou mais compacto.

Caminhos de ferramentas como /C:/… agora são aceitos, o edit aceita old_str / new_str como apelidos, vários caminhos unidos em uma única string são compreendidos (dentro do projeto) e as mensagens de erro ficaram mais claras.

Comandos de shell em segundo plano de longa duração, como servidores de desenvolvimento, não bloqueiam mais novos comandos de shell.

Arquivos temporários agora são limpos com mais segurança, e novas tarefas não são mais reportadas como falhas quando apenas o salvamento do título automático falha.

O Mixdog Desktop agora funciona no Linux como AppImage ou pacote .deb, para x86_64 e arm64 (glibc 2.31 ou mais recente; Ubuntu 20.04, Debian 11 e posteriores), e se atualiza automaticamente. No GNOME com Wayland, o Computer Use captura telas pela extensão GNOME Shell do Mixdog incluída, mostra seu indicador de «em uso» no shell sem tirar o foco da janela controlada e é interrompido com Ctrl+Alt+Esc; após instalar a extensão pela primeira vez, saia e entre novamente uma vez.

O Mixdog para Android 0.1.12 traz um novo pareamento: no PC, abra Configurações > Conexão > Celular, escaneie o código QR para instalar o app, depois digite no app o código de 6 dígitos mostrado ali e permita no PC. Também corrige a caixa de mensagem escondida atrás do teclado no Android 15.

## v1.1.0 - 2026-10-11

- Uma nova opção Celular em Configurações > Conexão exibe um código QR para instalar o app móvel do Mixdog (disponível no iPhone pelo beta do TestFlight e no Android como APK). Após a instalação, o emparelhamento é concluído inserindo um código de 6 dígitos no app e aprovando-o no seu PC desktop.

- O app web agora pode receber notificações push de todos os PCs emparelhados, mantendo você atualizado sobre tarefas concluídas e respostas do modelo em todos os seus computadores.

- Arquivos Markdown agora oferecem visualizações de Pré-visualização, Rich e Código-fonte, além de estrutura tópica e pré-visualização lado a lado. O editor rich salva as alterações diretamente no arquivo preservando frontmatter, quebras de linha e formatação intacta, com detecção de conflitos e backups de edições retidas caso o arquivo seja modificado externamente.

- Os projetos registrados na barra lateral de sessões agora são organizados em pastas acima das sessões recentes, exibindo suas conversas mais recentes e um botão para iniciar uma tarefa no projeto. Categorias e pastas podem ser reorganizadas arrastando, e menus de contexto com clique com o botão direito permitem abrir, renomear, favoritar, arquivar, excluir ou herdar sessões.

- O suporte do aplicativo desktop para Macs com processador Intel (macOS x64) está de volta, sem dependências do ONNX. A memória mantém a busca lexical, enquanto a busca semântica local e o raciocínio automático são omitidos no hardware Intel.

- Salvar como não substitui nem exclui mais o arquivo de destino existente caso o download falhe. A remoção de um dispositivo emparelhado em Configurações > Conexão é repetida automaticamente ao reconectar se o relay estiver temporariamente indisponível.

- A leitura e edição de arquivos vinculam a reutilização de cache e os índices de intervalo a versões exatas e verificadas dos arquivos. A exclusão ou aplicação de patches em arquivos grandes com mais de 8 MiB no apply_patch limita o uso de memória em vez de ler arquivos inteiros, e as permissões de pré-visualização de HTML local ficam estritamente isoladas à sessão de origem.

- Os valores padrão de configuração ficam no código em vez de arquivos em disco: os arquivos de configuração agora armazenam apenas suas alterações personalizadas, permitindo que as definições intocadas adotem diretamente os novos padrões nas atualizações.

- O consumo de recursos em segundo plano foi significativamente reduzido quando o sistema está ocioso, com menos revisões do daemon, monitoramento de arquivos suavizado na busca e consolidações diárias em cache para estatísticas de uso.

- Shift+Enter insere quebras de linha de forma confiável no compositor de mensagens mesmo após caracteres com Shift, e pressionar Enter não dispara mais o envio prematuro durante a composição de texto em coreano no IME.

- Revisão da qualidade das traduções em todos os 11 idiomas suportados, corrigindo rótulos da interface e atualizando caixas de diálogo localizadas.

## v1.0.12 - 2026-10-10

- O registro de alterações em Configurações > Sobre lista as notas da versão instalada; na v1.0.11 ele ainda terminava na v1.0.10, tanto no app desktop quanto na página web remota.

- O registro de alterações está disponível em todos os idiomas do app e, após uma atualização, o app mostra uma única vez as novidades daquela versão.

- O Raciocínio automático vem ativado por padrão nos modelos compatíveis: cada mensagem e cada etapa de ferramenta recebe o esforço de raciocínio de que precisa. O modelo é baixado em segundo plano no primeiro uso, e não na inicialização, e o cartão Integrado mostra o modelo e no que ele se baseia.

- Os links de arquivos em uma conversa abrem ao lado dela, no painel lateral, como abas. Um novo link substitui a aba de pré-visualização, então os links não acumulam abas; uma aba é mantida quando você clica nela duas vezes, escolhe Manter aberto ou edita o arquivo. No máximo oito abas de arquivo ficam abertas. Configurações > Geral > Pré-visualização de links desativa isso.

- Arquivos CSV e TSV abrem como uma tabela editável: copie e cole células, adicione ou remova linhas e colunas, salve com Ctrl+S e desfaça ou refaça com Ctrl+Z e Ctrl+Y.

- Arquivos PDF e do Office (Word, PowerPoint, Excel) têm pré-visualização no painel lateral. As páginas do Office reabrem instantaneamente, e um link começa a converter seu documento assim que você aponta para ele.

- As conversas podem ser marcadas com estrela: os favoritos ficam no topo da lista de sessões, e a estrela aparece ao passar o mouse sobre uma linha.

- A busca encontra texto em conversas anteriores. Uma conversa excluída não deixa resultados de busca para trás, qualquer que seja a forma como foi removida.

- Rolar para cima enquanto uma resposta está sendo transmitida mantém sua posição, em vez de voltar de repente para o final.

- As ações do GitHub em uma resposta são agrupadas em um único cartão do GitHub, e o ciclo do indicador de raciocínio não dá mais um salto ao reiniciar.

- As contas de provedores mostram o e-mail de login, e conectar de novo a mesma conta mantém seu nome e o histórico de uso, em vez de adicionar uma nova entrada. A caixa de diálogo de uso não lista mais as contas que foram desconectadas.

- Um prompt retirado da fila de volta para o rascunho não reaparece mais após uma reinicialização, e reabrir o app rapidamente mantém a conversa editável, em vez de abri-la somente para leitura.

- Correções de tradução: rótulos errados, como Git em italiano, Models em vietnamita e Effort em chinês e japonês, agora aparecem corretamente.

- Na interface web do celular, Enter insere uma quebra de linha e o botão de envio envia.

- A Memória inicia em perfis do Windows cujo nome da pasta de usuário não é ASCII simples.

- Atualizações de segurança para as dependências image-size e js-yaml (CVE-2025-71329, CVE-2026-84375).

## v1.0.11 - 2026-10-08

- O navegador integrado volta a exibir páginas em telas do Windows com escala acima de 100%, em vez de falhar com "Browser display did not recover after the page changed" (#8). As páginas também acompanham mudanças na escala da tela, inclusive as abas que não estavam visíveis na hora.

- Arquivos do Word, PowerPoint e Excel (.docx, .pptx, .xlsx, .xlsm) podem ser anexados a mensagens e automações, e o texto deles chega a todos os modelos. Tipos de arquivo que não podem ser anexados agora avisam isso e inserem o caminho do arquivo no lugar, e arquivos vazios ou que não são PDFs de verdade são rejeitados com uma mensagem clara.

- PDFs e imagens do início de uma conversa continuam sendo enviados ao modelo depois que o app reinicia. Modelos sem suporte nativo a PDF recebem o texto do PDF. A leitura de um PDF com mais de 100 páginas retorna as primeiras páginas como texto, e PDFs protegidos por senha ou inválidos retornam um erro claro em vez de quebrar as requisições seguintes.

- Imagens e arquivos retornados por ferramentas MCP chegam ao modelo como imagens e arquivos, e não como texto codificado bruto; mídias não compatíveis ou grandes demais são descritas.

- Os resumos feitos quando uma conversa longa é compactada agora incluem mensagens longas e registram as imagens e os arquivos anexados.

- Modelos locais somente de texto mantêm o texto dos documentos anexados, e as imagens anteriores viram uma nota curta em vez de interromper a conversa.

- O Feedback, com capturas de tela opcionais, pode ser enviado em Configurações > Sobre, e o registro de alterações também pode ser lido ali.

- Mensagens recentes da conversa podem ser encontradas por significado na recuperação da memória logo depois de salvas.

- Os resultados de busca só são reutilizados enquanto ainda estão atuais (#7), e uma busca de lista de arquivos após uma busca de conteúdo retorna nomes de arquivos em vez do conteúdo anterior (#9).

## v1.0.10 - 2026-10-08

- Provedores de API personalizados podem ser registrados em Configurações com adaptadores de conexão específicos de cada provedor.

- Os QR codes de conexão remota aparecem somente depois que o relay está pronto, e os cartões de pareamento obsoletos são removidos.

- Os aliases que acompanham automaticamente as atualizações dos modelos do OpenRouter podem ser selecionados e salvos para o Principal e para os agentes. Aliases mais recentes e modelos estáveis não ficam mais ocultos indevidamente pela idade do catálogo, por prévias mais novas ou pelos limites de família do seletor de modelos.

- A inicialização do patch nativo mantém o processo ativo enquanto a verificação está pendente, evitando uma saída antecipada quando o pré-aquecimento e a verificação se sobrepõem.

## v1.0.9 - 2026-10-07

- As instruções comuns e do projeto chegam a toda nova conversa mesmo quando a extensão Memória não está instalada ou está desativada; essa chave agora cobre apenas as ferramentas de memória e de recuperação. Salvar uma instrução não espera mais vários segundos pelo modelo de embeddings, as instruções entram como foram escritas, sem ids internos, e podem somar até 32 KB.

- Entrar no GitHub pelas Configurações, e todo outro recurso que inicia um processo de terminal, volta a funcionar no app desktop instalado, em vez de falhar com "posix_spawnp failed". Uma conta extra obsoleta do GitHub guardada pelo gh não faz mais um login bem-sucedido informar "no account is signed in".

- Browser Use e Computer Use não pedem mais aprovação antes da primeira chamada em uma sessão, e `setup set_first_use_approval` foi removido.

- O cartão de aprovação de ferramentas combina com os cartões empilhados acima do campo de entrada: o ícone de alerta, o título e a ferramenta ficam em uma linha, o motivo aparece embaixo com apenas o comando, caminho ou URL que está sendo aprovado (sem linha de pasta nem despejo de argumentos), e Negar fica discretamente ao lado de Permitir.

- Modelos novos obtêm suas capacidades dos catálogos dos provedores em vez de esperar por uma versão: mudanças de esforço no meio da conversa na rota ChatGPT, Fast mode e configurações de cache na rota da API da OpenAI, Fast mode no Claude e esforço de raciocínio na xAI. GPT-6.1 Sol e Claude Sonnet 5.5 já são cobertos, e o alternador Fast não aparece mais em modelos Claude que não podem usá-lo.

- O Claude Sonnet 5.5 volta a mostrar suas notas entre chamadas de ferramentas, e os modelos Claude Fable e Mythos podem usar a busca na web hospedada.

- A versão de cliente que cada provedor espera é lembrada entre execuções, de modo que uma reinicialização ou um início offline não volta mais a um valor antigo embutido.

- Mais erros de "conversa longa demais" de GLM, Kimi, Qwen, MiniMax, xAI e outros backends agora disparam a compactação em vez de encerrar o turno, e uma sobrecarga do Claude no meio de uma resposta segue as mesmas regras de nova tentativa e de fallback que uma no início da resposta.

- Avisos e erros não se empilham mais acima do campo de entrada: confirmações de comandos com barra e falhas de microfone, anexos e comandos aparecem como notificações, e o progresso do download de voz aparece apenas no cartão correspondente nas Configurações. Todo erro agora tem a mesma aparência, sem cartão com moldura, e os downloads de modelos locais mostram uma barra de progresso de largura total abaixo da linha.

## v1.0.8 - 2026-10-05

- O app para macOS é assinado com um certificado Developer ID e notarizado pela Apple, de modo que uma cópia baixada abre sem aviso do Gatekeeper e a atualização automática do macOS pode instalar novas versões. Os pedidos de permissão de microfone e de AppleScript agora explicam para que o Mixdog os usa.

## v1.0.7 - 2026-10-04

- O Browser Use no celular transmite a página do desktop ao vivo, em vez de atualizar capturas, e aceita as mesmas entradas de mouse, toque, roda, teclado e IME do painel do desktop. Quando um agente passa a página para o usuário (por exemplo, um CAPTCHA), o celular também a abre.

- A atividade das ferramentas na transcrição é mais fácil de percorrer: cada linha começa com um verbo curto, leituras e buscas mostram resultados por arquivo, listagens mostram linhas de arquivos, comandos ficam em sua própria caixa, a saída de `git diff` é exibida como diff, e uma página visitada pelo navegador ganha um cartão que a reabre no painel.

- As notificações de turno concluído chegam mais rápido, mostram texto simples em vez de Markdown bruto, terminam em uma frase completa e não são mais retidas por tarefas de shell longas em segundo plano.

- Sessões usadas recentemente abrem mais rápido após uma reinicialização e ao serem revisitadas.

- A ferramenta setup pode gerenciar contas OAuth, opções de desenvolvedor, fixações da barra de atividades e o servidor MCP de um plugin, e as requisições de sessões em painéis divididos são tratadas. A janela de limpeza automática de um provedor agora substitui a global.

- A ferramenta Git é ativada onde quer que `git` esteja instalado, sem instalar uma extensão. Agendamentos e webhooks sempre entregam na sessão do app.

- A interface do app permanece em escala de 100%, as configurações salvas em outra janela ou terminal são aplicadas imediatamente, e bordas, ícones, espaçamento de listas e entradas de diálogos ficam mais consistentes.

## v1.0.6 - 2026-10-03

- As notificações push no celular ficam silenciosas enquanto o app está na tela, acompanham uma assinatura que o navegador renova por conta própria, e o alternador se desativa quando as notificações são bloqueadas nas configurações do sistema.

- O app do celular não fica mais preso na tela de carregamento ao voltar após uma atualização do relay; ele termina de carregar assim que o desktop reconecta, e uma primeira inicialização rápida não deixa mais de instalar o service worker do app.

- No Android, o gesto de voltar fecha o painel ou menu aberto sem piscar a barra de navegação.

- As abas do workspace, o cabeçalho do painel lateral e o botão de limpeza do Studio ficaram mais compactos, e a aba selecionada se destaca com mais clareza.

- Os rótulos de uso ficaram mais curtos, a cota até a redefinição passa a ser por hora quando falta menos de um dia e nunca excede o que resta, e as traduções foram aprimoradas em todos os idiomas.

## v1.0.5 - 2026-10-03

- O app desktop pode emitir uma notificação do sistema, com som, quando um turno termina com sua resposta final, e a notificação leva de volta àquela sessão.

- As ferramentas Office criam documentos docx, xlsx e pdf a partir de HTML por meio de uma sessão de navegador compartilhada.

- O Uso mostra estimativas do valor da cota e totais por sessão.

- Os hosts de Browser e Computer Use ficaram mais robustos: transformações de quadros, privacidade visual, capturas de tela em blocos e recuperação após falhas.

- A verificação de sintaxe do PowerShell não confunde mais fragmentos de verbo-hífen dentro de caminhos com cmdlets.

- `adm-zip` foi atualizado para a 0.6.1 por causa do CVE-2026-102282.

## v1.0.4 - 2026-10-01

- Os seletores de modelo são atualizados assim que um provedor muda. Logins OAuth feitos pelo navegador (OpenAI, Grok, Cursor, Antigravity) e trocas de conta agora recarregam o seletor imediatamente, em vez de só após reiniciar, e um provedor conectado, removido ou trocado em uma janela também atualiza todas as outras janelas do desktop e os celulares pareados.

- Fechar a janela não pergunta mais o que fazer. As Configurações oferecem a opção "Ao fechar a janela" entre ocultar na bandeja (o padrão) e sair completamente, o ícone da bandeja fica disponível desde a inicialização, e a confirmação de saída dentro do app foi removida.

- As linhas de agentes do Workflow têm a mesma aparência em todos os lugares: uma linha sem modelo fixado, inclusive Web Search, mostra "Padrão", e os nomes de agentes e rótulos de modelos permanecem sem tradução. As abas do workspace não selecionadas repousam sobre uma placa suave, em vez de divisórias finas.

- A ferramenta Goal e a habilidade goal-management descrevem os Objetivos como uma lista de tarefas para trabalho aprovado que se estende por vários turnos, e excluem agendamentos recorrentes e objetivos que esperam semanas por eventos externos.

## v1.0.3 - 2026-10-01

- A geração de mídia registra uma linha de uso por tarefa de imagem ou vídeo, com os tokens, imagens, segundos e custo informados pelo provedor, de modo que a mídia de Gemini, Antigravity, Codex e xAI aparece nos totais de uso e custo junto com os modelos de texto. As tarifas de mídia vêm do catálogo de preços publicado.

- Parar e Retomar do Computer Use se recuperam bem após uma limpeza que falhou: workers ociosos são aposentados em vez de expirar, e um Parar ou Retomar do usuário limpa o estado obsoleto "input not confirmed released".

- Sessões que aguardam tarefas de shell em segundo plano aparecem como aguardando, e não como ociosas, e o indicador de tarefas de shell não mostra mais as tarefas de um dono anterior nem perde atualizações que chegam durante uma consulta. As listas de sessões e agentes evitam redesenhos redundantes quando nada mudou. O gráfico de uso, as páginas da barra lateral, as abas do workspace, as listas de extensões e os diálogos têm um estilo renovado.

- Varreduras idênticas e simultâneas de grep e read compartilham uma única varredura nativa, os resultados em cache são invalidados por caminho após edições, e um patch cancelado para antes de gravar mais arquivos. A busca do code graph reconhece caminhos do Windows independentemente de maiúsculas, separadores e prefixos verbatim (`\\?\`) e UNC. Um hook pré-ferramenta com falha agora bloqueia a ferramenta em vez de deixá-la executar.

- A habilidade browser mantém as páginas em segundo plano, a menos que a própria página seja o resultado entregue ou que o usuário precise agir nela. O desenvolvimento do desktop (`npm run dev`) e os scripts E2E diretos do Windows rodam em um perfil novo e isolado na porta CDP `9342`.

## v1.0.2 - 2026-10-01

- Os botões de copiar da transcrição podem gravar na área de transferência a partir da janela confiável do desktop. O texto das respostas, blocos de código, saídas de ferramentas e diffs por arquivo têm cobertura de regressão para o texto copiado exato, novas tentativas e conteúdo em mudança; leituras da área de transferência e permissões para outras janelas continuam bloqueadas.

- Os comandos de modelo e de esforço abrem o seletor de modelos da conversa atual, e os agentes desativados mantêm o modelo selecionado para eles. O tutorial inicial explica a recomendação do modelo Maintainer, e os diagnósticos agora cobrem provedores locais, recursos integrados, voz e plugins ausentes ou inválidos.

- Os links de arquivos do Windows lidam com separadores codificados e caminhos com espaços ou texto coreano. Uma menção de arquivo cuja busca inicial falhou pode ser clicada para tentar de novo. Selecionar tudo no Studio inclui todos os itens da aba, e não apenas as páginas já carregadas.

- O Computer Use mantém as referências de captura alinhadas com as releituras de acessibilidade, reassocia com segurança controles reconstruídos apenas quando a identidade observada coincide, e espera enquanto a área de trabalho de entrada está bloqueada, em vez de tratar o bloqueio como uma falha do observador.

- As abas do workspace e o tutorial inicial têm um estilo mais claro, a barra lateral de sessões começa aberta, e os grupos de ferramentas não mostram mais o selo agregado de falha. O texto das instruções do projeto não é mais adicionado ao bloco de ambiente do prompt do sistema. Os pacotes publicados excluem testes de desenvolvimento aninhados.

## v1.0.1 - 2026-09-30

- O app desktop no Windows 11 agora fica em uma moldura de janela Mica com um shell monocromático e mais calmo: pop-ups e painéis se separam por sombra em vez de bordas, as seleções não ficam mais azuis, e o destaque é reservado para o estado ativo. O texto segue uma única escala tipográfica (de legendas de 12px a títulos de página e números de destaque de 20px), a aba selecionada é um cartão elevado, os botões destrutivos permanecem neutros até receberem o cursor, e os gráficos de uso e de contexto compartilham uma única paleta.

- Fechar a janela pergunta uma vez se o Mixdog deve continuar rodando na bandeja ou sair completamente, e lembra a resposta. Sair enquanto um agente ainda trabalha pergunta sempre.

- O uso da assinatura mostra a parcela de cada modelo como uma área empilhada sob a linha total, e o cartão de detalhes só segue o ponteiro dentro do gráfico.

- A conversa permanece presa à última mensagem quando um cartão muda de altura durante a rolagem. Arquivos SVG gravados por um agente aparecem como resultados de imagem e abrem no visualizador do sistema, e os agentes entregam trabalho visual, como SVGs ou páginas HTML, como arquivos salvos em vez de colar o código-fonte.

## v1.0.0 - 2026-09-30

- A Memória não pode mais ser derrubada por uma reconstrução do runtime. Um runtime de memória reconstruído é publicado com uma nova tag de versão, em vez de substituir arquivos que os apps instalados verificam, um novo runtime é instalado ao lado do que está em uso, em vez de excluí-lo enquanto o PostgreSQL ainda roda a partir dele, e dois processos instalando ao mesmo tempo não apagam mais o download um do outro. Os deploys de desenvolvimento local se recusam a rodar a partir de um branch atrás do seu upstream.

- Os cartões de ferramentas não marcam mais chamadas concluídas como falhas. Um comando cuja saída contém uma linha `status:`, um `git diff --quiet` ou `git grep` que informa uma diferença ou nenhuma correspondência, uma consulta code_graph que não encontra o símbolo e a paginação de resultados tidy armazenados agora aparecem como concluídos; um comando git que sai com código diferente de zero aparece como uma saída, como no shell; e um comando de navegador ou computador interrompido porque o usuário assumiu o controle aparece como cancelado.

- Menos chamadas de ferramentas falham por um deslize de argumento na primeira tentativa: a ferramenta git adiciona um `git` inicial ausente, read declara no esquema seu limite de 10 alvos, e um Goal cheio de tarefas concluídas diz como abrir espaço para novas. Os logs de falha agora registram os alvos de read e o tamanho total dos lotes de caminhos.

- As requisições são cobradas na faixa com que realmente foram enviadas: requisições Fast e Priority usam suas tarifas publicadas, uma requisição Fast repetida como padrão é cobrada como padrão, e as variantes Cursor Fast são cobradas como seu modelo do catálogo. Alternar o Fast atualiza a linha de status imediatamente.

- As regras de validação de dados do Excel são verificadas antes de a pasta de trabalho ser criada, de modo que um tipo de regra desconhecido ou um limite ausente falha logo no início em ambos os backends. O brilho de atividade ao vivo é uma faixa mais curta e mais pálida, e os nomes dos resumos de ferramentas usam o peso médio.

## v0.9.175 - 2026-09-29

- Os agentes Claude agora mantêm o cache da conversa por 5 minutos, em vez de uma hora. Quando a próxima requisição de um agente chega depois que esse cache expirou — após uma compilação ou teste longo, ou quando um agente concluído é retomado — ele primeiro compacta a conversa, de modo que a requisição reescreve a conversa compactada, e não tudo o que o agente havia acumulado. Em uma reprodução do uso recente de agentes Claude, isso reduziu o custo em tokens dos agentes em cerca de um quarto. As sessões Lead não mudam.

- Muitas sessões rodando lado a lado não se atrapalham mais. As mensagens pendentes são mantidas por sessão, os resumos de sessão e o uso do gateway são acrescentados em vez de reescritos, as transcrições armazenadas são analisadas fora do loop principal, e um ciclo de memória com falha recua em vez de tentar de novo em um loop apertado. Quando o daemon encerra, ele registra o motivo. O host de sessões multiprocesso separado foi removido; as sessões rodam no próprio daemon.

- O uso da assinatura registrado antes de uma troca de conta agora conta para a conta que estava em uso quando o registro começou. Grok, Claude e Cursor informam suas versões de cliente atuais em vez de fixas.

- O app desktop não mostra mais uma sessão em branco quando o daemon entrega o conteúdo logo depois de responder à requisição de abertura. O script de inicialização do app empacotado é permitido pela política de segurança de conteúdo, e foram corrigidas as verificações da raiz do projeto, os erros de despacho do relay e a restauração de sessões do navegador.

- Pastas de trabalho e documentos editados sem o Office: limpar uma célula vazia não exclui mais a célula seguinte, excluir um comentário encontra comentários com formatação de autor, partes vinculadas por caminhos absolutos são resolvidas, e texto que parece um padrão de substituição é inserido literalmente.

- Os runtimes baixados (PostgreSQL, pgvector, fontes, FFmpeg) são verificados contra checksums fixados antes do uso. As ferramentas nativas corrigem uma análise de id de janela que podia dividir um caractere multibyte, um cálculo de tempo que podia estourar e uma substituição de snapshot que podia deixar um arquivo parcial.

## v0.9.174 - 2026-09-29

- A caixa de diálogo de uso agora responde a uma segunda pergunta: como a cota de uma assinatura foi consumida. Ao lado do uso de tokens, uma aba Uso da assinatura acompanha as janelas de limite de cada provedor — Codex, Claude, Grok, Cursor, Antigravity e OpenCode Go — conforme sobem e são redefinidas, com os modelos que moveram o medidor e o histórico das janelas anteriores. O Mixdog registra cada leitura de cota que mede; um aumento sem nenhuma requisição do Mixdog por trás aparece como uso externo ao Mixdog, como o app web do provedor. Um medidor de provedor no menu de uso abre diretamente a assinatura correspondente.

- `/doctor` também funciona no app desktop, como uma caixa de diálogo (também em Configurações → Sistema → Doctor). Ele executa as mesmas verificações de integridade somente leitura do TUI, todas de uma vez, com um prazo por verificação para que uma travada não oculte as outras, e todo aviso ou falha diz como corrigir.

- Novas apresentações do PowerPoint são projetadas em HTML. O modelo organiza cada slide em HTML e CSS, um Chrome ou Edge local o renderiza, e `author` transforma o que o navegador desenhou em objetos nativos e editáveis do PowerPoint: caixas de texto que mantêm as quebras de linha do navegador, formas, linhas, tabelas, gráficos e imagens. O texto coreano quebra onde o leitor espera, uma verificação de geometria recusa slides cujos alinhamentos declarados o navegador não consegue confirmar, e `render` mostra cada página HTML ao lado da sua renderização no PowerPoint. O caminho por script permanece para apresentações que querem os dispositivos medidos do kit, ou quando não há navegador local.

- Inserir ou excluir linhas e colunas em uma pasta de trabalho sem o Excel agora reescreve tudo o que cita essas células, como o Excel faz: fórmulas de todas as planilhas, nomes definidos e áreas de impressão, formatos condicionais, validações, séries de gráficos, fontes de tabelas dinâmicas, filtros, vínculos, mesclagens, tabelas e desenhos. As células se moviam enquanto suas referências ficavam no lugar, de modo que o total de um relatório continuava somando o intervalo antigo e mostrava 72,200 onde o Excel mostrava 74,700. Uma edição cujas referências não podem ser reescritas é recusada, com a lista, antes de qualquer alteração.

- PDFs e faixas de planilhas compostas mantêm datas, horas, frações e valores coreanos em uma única linha. "10월 14일", "14시 30분", "3분의 1", "12만 6천 원" e "24억 원" não quebram mais no meio, o que dividia uma data de decisão ou uma economia em duas linhas.

- Os arquivos do Office saem iguais, seja o Microsoft Office ou o gravador portátil integrado que os produziu. Uma longa comparação lado a lado dos dois alinhou espaçamento, modo de compatibilidade e tabelas do Word; autoajuste, recuos, bordas, configuração de impressão e gráficos predefinidos do Excel; quebra de texto coreano, fontes do Leste Asiático, rodapés, cortes de capa, sombras e transparência do PowerPoint; e alinhamento e larguras de tabela do PDF. As verificações de revisão relatam os mesmos problemas em ambos os backends, os gráficos do Excel podem ler o intervalo de outra planilha, e `set_chart_data` mantém os vínculos e os nomes de séries de um gráfico.

- O Computer Use roda no macOS e no Linux. Os builds de desktop para esses sistemas incluem um backend nativo que fala o protocolo do host do Windows e aplica as mesmas listas de ações e limites. Uma sequência agora também pode agir sobre vários elementos de uma observação: cada passo seguinte comprova de novo seu elemento na árvore de acessibilidade ativa, e a cadeia para diante de uma troca de janela, uma falha, ou um elemento desativado ou fora da tela.

- O app do celular abre e reconecta mais rápido e move muito menos dados. A transcrição aparece logo após a primeira sincronização, reconexões curtas retomam como deltas em vez de uma ressincronização completa, o celular espelha apenas a aba que mostra, a revisão recolhida do turno lê nomes e contagens de arquivos sem o texto do patch, e buscas lentas em projetos não seguram mais outras chamadas. Um app de celular mantido aberto verifica se há um novo deploy ao voltar para o primeiro plano, e adota um fora da tela, mesmo no meio de um turno.

- O daemon usa menos memória e trava menos: as sessões salvam apenas o que mudou, o registro de uso funciona fora da thread principal, bloqueios de arquivo e chamadas git não o bloqueiam mais, e transcrições longas são paginadas em blocos de 1 MB. O desktop e o celular renderizam Markdown em streaming e a rolagem por toque com menos layouts, e a transcrição do app web não treme mais enquanto as linhas são medidas.

- A entrada de voz mostra que está se preparando até a captura realmente começar, aquece a transcrição enquanto você fala e transcreve mais rápido sem bloquear o app.

- Os resultados das ferramentas custam menos tokens ao modelo. `read` retorna suas linhas sem números de linha — o TUI e o desktop continuam desenhando a margem — para cerca de 16% menos tokens em sessões gravadas; os avisos de shell e de tarefas ficaram mais curtos; e as edições informam caminhos relativos ao diretório de trabalho.

- A compactação carrega menos material obsoleto em janelas de contexto grandes. A conversa literal e o histórico recente de ferramentas mantidos por uma Compactação são limitados a 20,000 tokens, em vez de crescer com a janela. Uma captura do navegador ou observação do desktop que uma posterior da mesma página ou janela substituiu mantém apenas seu resultado e um ponteiro para o original arquivado, e as respostas mais antigas descartam o replay opaco do provedor, mantendo suas chamadas e resultados de ferramentas.

- Um provedor brevemente indisponível não encerra mais o turno no momento em que suas próprias tentativas se esgotam. Enquanto nada chegou à tela, o turno espera mais alguns ciclos de recuperação, de 15 segundos até um minuto, e segue o Retry-After do próprio servidor. Quando um stream é cortado enquanto os argumentos de uma chamada de ferramenta ainda estão chegando, essa chamada não é executada, e o modelo é instruído a dividir o conteúdo em chamadas menores em vez de reenviá-lo inteiro.

- O OAuth do Cursor e do Antigravity (Gemini) são chaves separadas em Configurações → Desenvolvedor, e cada uma só é ativada depois que você confirma o risco de restrições de conta que vem com o uso desse provedor via OAuth. A variável de ambiente `MIXDOG_DEV_PROVIDERS` não as ativa mais.

- A conversa não salta mais quando as barras acima do campo de redação abrem ou fecham: elas deslizam sobre o movimento em vez de deslocar a transcrição por toda a sua altura de uma vez, e abrir uma sessão não pisca mais uma contagem de revisão do turno que desaparece um instante depois.

- Renomear um arquivo ou pasta no explorador mantém suas abas de editor abertas no novo caminho. Um arquivo com edições não salvas é recusado até ser salvo, pois seu buffer pertence ao caminho antigo.

- O Studio limpa em lote: os itens selecionados, tudo antes de uma data, entradas cujos arquivos sumiram, ou tudo de um tipo. Configurações → Sobre lista um endereço de suporte com os botões Copiar e Enviar e-mail, e a caixa de diálogo Clear browsing data do navegador integrado foi removida.

- Um turno de objetivo automático que não chama nenhuma ferramenta agora espera em vez de pedir de novo.

## v0.9.173 - 2026-09-22

- Uma mensagem enfileirada restaurada mantém o texto que o daemon confirmou. Restaurar uma delas publica duas vezes no mesmo instante — primeiro o palpite local, a resposta do daemon um momento depois — e ambas eram carimbadas com o relógio. Quando caíam no mesmo milissegundo, o prompt tratava a segunda como a primeira e mantinha o palpite, de modo que uma mensagem editada podia voltar sutilmente errada. O prompt agora segue o próprio texto, e não apenas o carimbo.

- Saltar duas vezes no mesmo instante não perde mais o segundo salto. Dois pedidos de "ir para esta linha" dentro do mesmo milissegundo traziam o mesmo carimbo, e o editor lia só o carimbo, então o segundo era descartado e o cursor ficava na primeira linha.

- Uma busca que falha não derruba mais todo o mecanismo de busca. O mecanismo já sabia responder a uma requisição ruim com um erro e continuar atendendo, mas o build distribuído era compilado de modo que qualquer falha matava o processo — perdendo todas as outras buscas em andamento e o índice de arquivos aquecido. Agora ele sobrevive, responde só àquela requisição com um erro e mantém seus caches. Se uma falha ocorrer enquanto os arquivos estão sendo coletados, os caminhos já coletados ainda são publicados, em vez de sumir silenciosamente da resposta.

- Aplicar e Excluir em uma linha de provedor local ficam na mesma linha. Eles diferiam em dois pixels porque a linha misturava um campo mais alto com um botão mais baixo.

- A limpeza de código avisa quando uma ferramenta não é a que você pensa que é. Se um formatador ou linter com o mesmo nome estiver acessível na sua máquina, mas não for o que o Mixdog executa, o relatório agora cita os dois, com as versões — executar o outro binário não diz nada sobre o resultado que você viu. Uma limpeza também separa os achados em arquivos que você já tocou dos achados em arquivos intocados no repositório, de modo que aplicar correções a um diretório inteiro não reescreve mais arquivos que você nunca quis alterar.

- Atualizar o app instalado não para mais porque o antivírus removeu um arquivo que a atualização descarta de qualquer forma. A preparação desempacotava o app instalado inteiro e excluía a parte que ia substituir; um único recurso do renderer em quarentena bastava para abortar o deploy.

## v0.9.172 - 2026-09-21

- Uma página não abre mais anunciando downloads que ela nunca fez. Os arquivos salvos pertencem à sessão, mas cada página rastreava o que já havia informado a partir do zero, então toda página aberta depois saudava quem chamava com todo o histórico acumulado — uma página de busca informando um arquivo que outra aba havia salvo minutos antes. Uma nova página já começa ciente do que aconteceu antes de existir; um arquivo salvo enquanto ela está aberta ainda chega até ela.

- As falhas do próprio navegador não são mais lidas como falhas da página. Uma chamada CDP com timeout, um frame filho que não pôde ser anexado, uma interceptação que não pôde ser respondida — tudo isso era registrado como erro de console da página, de modo que uma resposta sobre um site saudável podia começar com `CDP Runtime.evaluate timed out` como se o site o tivesse registrado. Elas continuam legíveis por meio de `console`, marcadas com `[browser]`, e não contam mais entre os erros pelos quais uma página responde.

- Um prazo atingido atrás de um diálogo aberto diz isso. Um alert, confirm ou prompt congela a thread principal da página, então a chamada seguinte morria no timeout apenas com o prazo — e a nova tentativa óbvia expirava do mesmo jeito. O erro agora cita o diálogo e seu texto, e diz para respondê-lo com `handle_dialog` antes de agir na página de novo.

- Uma mudança de rota no lado do cliente é respondida com a tela que ela produziu, não com a que quem chamou deixou. Apps de página única movem o endereço com `history.pushState` e renderizam a nova visualização um instante depois; nenhum documento é carregado, então a espera de estabilização viu uma página quieta e retornava de imediato — e um `expect.url` era satisfeito pelo novo endereço antes de qualquer coisa ser desenhada. Clicar em "Learn" em react.dev respondia com a página inicial sob o endereço `/learn`. Quando uma ação muda o endereço sem carregamento, a resposta agora espera a página se acalmar, e uma condição de URL não pode encurtar isso. Medido no harness com dispositivo real: as latências de navigate, click e snapshot não mudaram, pois só mudanças de rota no mesmo documento têm a espera extra.

- O detalhe de um WebSocket mostra a requisição de upgrade que ele realmente enviou. Apenas o endereço e a resposta do handshake eram registrados, então `network` respondia com uma seção de cabeçalhos de requisição vazia — e um upgrade recusado costuma ser explicado por `Origin`, `Sec-WebSocket-Protocol` ou um cookie. As credenciais continuam ocultas.

- Um clique que abre uma aba não é mais relatado como um clique que não fez nada. Um link `target="_blank"` deixa o documento atual intacto, então a resposta dizia "No observable change" e mandava procurar um elemento que o cobria — enquanto a página recém-aberta estava em `list_tabs` sem ser mencionada. A resposta agora cita a página que abriu e como agir sobre ela.

- `drag` aceita alvos sem snapshot como toda outra ação de ponteiro. Suas duas pontas só aceitavam refs ou coordenadas brutas, e os elementos que uma página torna arrastáveis — cartões, linhas de lista, zonas de soltar — muitas vezes não têm nome acessível e, portanto, nenhuma ref, então mover um exigia ancorar antes um snapshot visual, mesmo quando o seletor CSS era conhecido. `target` e `dropTarget` agora nomeiam as duas pontas, resolvidas juntas em uma observação; refs e coordenadas funcionam como antes, e as duas pontas ainda precisam ser endereçadas do mesmo jeito.

- Um arquivo salvo não é mais anunciado como requisição com falha. Um endereço que vira download cancela a própria navegação, e o Chromium informa esse cancelamento como `net::ERR_ABORTED`, então uma resposta que listava o download também o listava como falha de rede recente. As requisições canceladas — downloads, fetches que a página abandonou, navegações substituídas por outra — continuam legíveis por `network`, mas não são mais apontadas espontaneamente como falhas da página; uma requisição que realmente falhou continua sendo.

- Uma resposta `brief` não transforma mais um campo preenchido em uma mudança em toda a página. Ela compara com a observação anterior de quem chamou, e quando essa observação foi limitada ou filtrada, nunca havia informado o resto da página — então todo elemento fora dela era listado como "changed or new". Preencher três caixas de um formulário respondia com quinze elementos, e digitar uma palavra de busca respondia com cento e quarenta e seis. A resposta agora separa o que a ação comprovadamente mudou do que a observação anterior simplesmente nunca cobriu, e diz quanto da página essa observação continha. Nada é omitido em nenhum dos casos.

- Os cabeçalhos de requisição em `network` são os que realmente foram enviados. O Chromium informa primeiro um conjunto provisório e acrescenta idioma, codificação, client hints e cookies depois, então o detalhe de uma requisição podia mostrar dois cabeçalhos e parecer que a página nunca pediu conteúdo em coreano. O conjunto posterior é mesclado; as credenciais continuam sendo citadas e nunca exibidas. Os nomes de cabeçalhos não diferenciam maiúsculas de minúsculas e os dois relatos os grafam de modo diferente, então a mesclagem mantém uma entrada por cabeçalho — a grafia e o valor que foram para a rede — em vez de listar `User-Agent` e `user-agent` como se a requisição levasse os dois.

- Os sites veem o Browser Use como o build do Chrome que os renderiza. A string de agente ainda trazia a versão do app desktop e o runtime do Electron, enquanto os client hints recebidos pelas mesmas páginas citavam só o Chromium; o GitHub respondeu a essa contradição com um muro de login em um repositório público. A partição do navegador agora apresenta a string simples do Chrome — uma impressão digital a menos e menos desvios por "navegador não compatível" — e um user agent emulado ainda prevalece quando uma tarefa pede um.

- Páginas que não param de anexar frames voltam a poder ser observadas. Portais e primeiras páginas de notícias abrem espaços de anúncio e widgets em rajadas, e um snapshot iniciado no meio de uma rajada costumava desistir com "frame topology changed during observation" — de forma reproduzível, na primeira e na segunda tentativa. Observações não têm efeitos colaterais, então o coletor agora espera brevemente a rajada se acomodar e lê de novo, até um pequeno limite, em vez de entregar um erro a quem chamou por uma página que estava apenas ocupada. Quando uma leitura ainda falha, a resposta agora diz que a página está carregada e só a leitura dela falhou, de modo que o próximo passo é observar de novo, e não abandonar uma página que está bem.

- Uma página informa apenas as próprias falhas. Requisições e erros de console do documento anterior permaneciam nos registros, então um snapshot de uma página saudável podia listar requisições abortadas do site visitado antes dela, e `console` em uma página limpa podia responder com os erros da página anterior — ambos mandando o leitor atrás de uma falha que não existia. Carregar um novo documento os limpa; navegar dentro do mesmo documento os mantém, pois nada foi recarregado.

- As disputas de exibição do Browser Use não são mais falhas. Uma captura que perde para uma navegação ou um redimensionamento de janela agora responde com um marcador de nova amostragem em vez de um erro, pois o painel sempre ia pedir de novo o que a página mostrasse em seguida. A navegação comum costumava encher o log do app com falhas de captura — dezessete em uma execução do harness, nenhuma agora — e um celular pareado relatava a mesma disputa como "could not connect to browser screen"; agora ele refaz a amostragem na cadência ativa e só relata uma exibição que realmente deixa de progredir.

- Limpar os dados de navegação do Browser Use. O painel do navegador tem um botão de borracha que remove o cache, os dados que os sites armazenaram neste dispositivo e os cookies, cada um como uma decisão própria: o cache vem pré-selecionado porque perdê-lo custa apenas um recarregamento mais lento, enquanto os cookies desconectam você de todos os sites e nunca são o padrão. Cada escopo é limpo por conta própria, de modo que uma falha é relatada como falha em vez de sumir atrás dos escopos que funcionaram. Limpar os cookies também reescreve o arquivo selado que leva os logins de sessão entre reinicializações, de modo que um login que você limpou não volta na próxima abertura do app — e se esse arquivo não puder ser reescrito, os cookies são relatados como não limpos, e não como concluídos. Até agora a partição compartilhada crescia em disco sem nenhuma forma de recuperar o espaço.

- As métricas de `performance` do Browser Use informam a memória do processo que pinta a página, e não apenas o heap do JavaScript: uma página cujas imagens e camadas ocupam a memória costumava parecer pequena. A leitura cita o processo, pois um renderer pode pintar várias páginas do mesmo site.

- A política de domínios do Browser Use cobre conexões peer. Quando um operador restringe os domínios que uma página pode alcançar, o WebRTC não contorna mais o filtro via STUN e TURN: as conexões peer são recusadas na página e em todo frame filho. Sem política de domínios, nada muda, e isso continua sendo contenção para o código da página, e não uma fronteira de rede.

- Capturas de tela de elementos do Browser Use. `snapshot mode=visual` aceita `ref` ou `target` e retorna aquele elemento como uma imagem própria. A caixa é medida em pixels CSS do documento superior — frames do mesmo processo somam seu deslocamento no lado da página, um frame de origem cruzada soma o deslocamento de sua sessão sem o teste de acerto que protege a entrada, pois uma imagem não despacha nada e um frame sob uma transformação CSS ainda merece uma — e o recorte é escalado pela razão imagem-viewport, de modo que vale também em uma tela com zoom ou de alta densidade. Um elemento mais alto ou mais largo que a janela é recortado da captura do documento em vez do viewport, então uma tabela ou artigo longo chega inteiro, em vez de terminar na dobra; apenas uma página grande demais para capturar volta à parte visível, e diz isso. A imagem é somente para inspeção: nunca é vinculada como ancoragem de coordenadas, porque a ref continua sendo o modo de agir sobre o elemento. `mode=semantic`, `fullPage` e `format=pdf` recusam um alvo em vez de ignorá-lo.

- Fidelidade de entrada do Browser Use. `drag` agora completa o drag HTML5 da própria página: a interceptação de drag do Chromium entrega o payload que a página iniciou e o gesto termina como `dragEnter`/`dragOver`/`drop`, que é o que um cartão kanban, uma lista ordenável ou uma zona de soltar arquivos realmente escuta; páginas que só acompanham eventos de mouse mantêm o caminho anterior. `type` envia um evento de tecla real por caractere em vez de inserir a string inteira, de modo que autocompletar e combo boxes guiados por teclas reagem, enquanto caracteres fora do layout dos EUA (coreano, emoji) continuam sendo inseridos como texto. `press` envia os códigos de tecla dos EUA para a pontuação (`.` era Delete, `-` era Insert), impede que um atalho digite um caractere e não deduz mais Shift de uma letra maiúscula, o que transformava `Control+A` em `Control+Shift+A`. `upload` solta arquivos em um elemento que nunca abre um seletor de arquivos, com uma proteção que neutraliza um drop não tratado — caso contrário o navegador leva a página ao arquivo solto — e informa claramente quando nada o aceitou.

- Fidelidade de observação do Browser Use. `scroll text=` procura em frames e shadow roots como `read` e `expect`, escolhe uma correspondência entre eles e não rola mais até um elemento recolhido. `expect.text` normaliza espaços dentro de uma linha, mas mantém as quebras de linha, de modo que marcação indentada corresponde enquanto dois blocos separados nunca se fundem em uma frase. Os diagnósticos de console mantêm o que a página registrou: argumentos de objeto chegam como uma prévia legível em vez de uma mensagem vazia, as entradas citam o script e a linha que um leitor abriria, e um `throw` simples não capturado traz sua localização. Os snapshots marcam `aria-hidden`, um `select` nativo que falhou lista as opções que encontrou, e `aria-labelledby` é resolvido dentro de um shadow root.

- O Browser Use conta os diagnósticos que não coube mostrar. Um relatório de página mostra os três erros de console e falhas de rede mais recentes, o que parecia ser a história toda: doze falhas chegavam como três. O relatório agora informa o total e aponta para `console` ou `network` sempre que a lista é limitada.

- O Browser Use admite quando um trecho da página termina cedo. O texto visível de um snapshot é limitado, e o relatório dizia apenas "condensed", então um artigo longo parecia ser a página inteira. Os dois caminhos de snapshot — a captura de acessibilidade e o fallback do DOM — agora marcam um trecho cortado, e o relatório informa quanto ele contém e diz que a página tem mais.

- Os anexos informam o tamanho da imagem que realmente produziram. Ajustar uma imagem a um orçamento de patches de visão apara as bordas uma de cada vez, o que pode pedir uma caixa que a imagem não preenche; a versão resultante saía menor que o tamanho informado ao lado, e as coordenadas mapeadas por esse tamanho ficavam erradas. O redimensionamento agora informa as dimensões da imagem produzida.

- O Browser Use diz onde um script da página falhou. `evaluate` mantinha apenas a primeira linha do erro do navegador, então um script de várias linhas informava `TypeError: ...` sem nada para localizá-lo. A falha agora traz consigo o frame de pilha mais interno, e o harness de integração fixa a posição que um throw em uma linha posterior informa.

- O Browser Use nomeia um PDF em vez de relatar uma página vazia. Abrir um link para um PDF confirmava o endereço, mas o guest não tem visualizador para ele, então o snapshot mostrava uma página sem título, sem texto e com ruído de console sobre uma folha de estilo do visualizador bloqueada — nada que dissesse o que aconteceu. O relatório da página agora informa que o documento é um PDF que este navegador não consegue exibir e que o arquivo precisa ser lido a partir de sua URL, e as falhas que os componentes embutidos do próprio Chromium geram para seus recursos `chrome-extension://` não aparecem mais como erros de console ou de rede da página. O harness de integração cobre a navegação, o relatório silencioso e um snapshot posterior da página.

- O Browser Use para de rebater `close_tab` na aba visível. `list_tabs` imprime a página visível com um id de página comum, então mirar `close_tab` nela era respondido com `unknown background tab "p12"; call list_tabs` — a listagem que forneceu o id. A recusa agora diz que a página pertence ao painel do navegador e aponta para navegá-la para outro lugar ou `hide`, e nomes não relacionados continuam informando uma aba de segundo plano desconhecida.

- O Browser Use diz o que uma confirmação de saída realmente fez. Uma página que protege trabalho não salvo interrompia uma navegação com um diálogo `beforeunload`, e a resposta pedia `handle_dialog` — mas o Chromium responde a essa confirmação por conta própria, então a chamada sempre voltava "no JavaScript dialog is currently open" enquanto repetir a navegação repetia a mesma instrução. A resposta agora informa que a navegação foi abandonada e a página permaneceu, que não há nada a responder, e que o trabalho que a página guarda precisa ser concluído ou descartado antes; o harness de integração cobre a sequência inteira, inclusive a navegação passando assim que a proteção some.

- A emulação de localidade do Browser Use chega ao servidor. `emulate locale` definia apenas `navigator.language`, então a página continuava pedindo o idioma antigo e os sites negociavam conteúdo que a emulação contradizia; agora ela leva a localidade também como `Accept-Language`, e limpá-la restaura a negociação própria do navegador.

## v0.9.171 - 2026-09-18

- Recuperação de release: o artefato de relay de produção preparado é identificado apenas pela execução (`production-relay-<run_id>`) e é enviado com `overwrite: true`. O nome trazia a tentativa da execução, mas uma reexecução parcial preserva o job `stage-production-web-relay` bem-sucedido enquanto reexecuta `deploy-production-web-relay` como dependente do job que falhou, então o artefato com escopo de tentativa nunca existia e o deploy morria com "Artifact not found" antes de alcançar a produção. Foi exatamente assim que a v0.9.170 publicou sua release no GitHub e seu pacote npm sem fazer o deploy do relay web. `overwrite: true` impede que uma reexecução completa, em que o job de preparação de fato roda de novo, colida com o artefato da tentativa anterior, e o portão de release verifica tanto o nome quanto o overwrite.

## v0.9.170 - 2026-09-17

- Consolidação do prompt do sistema. Cada regra agora tem um único dono: a camada compartilhada (`rules/shared/*.md`) é apenas política de ferramentas e abre com `# Tool Calls` (agrupamento primeiro; `05-parallel-calls.md`), o papel Lead é um arquivo (`rules/lead/LEAD.md`: comunicação com o usuário, briefing de agentes e notificações de conclusão atrás de `<!-- tools: agent -->`, tom), e o contrato comum dos agentes é um arquivo (`rules/agent/AGENT.md`: cadeia de comando, sem autoverificação, inglês, formato do handoff). `00-general.md`, `02-persona.md`, `lead-brief.md`, `00-core.md`, `00-common.md` e `75-goal.md` foram removidos — as frases que sobreviveram foram para o arquivo que as possui, e as frases que a descrição de uma ferramenta já declara (`load_tool`, `Skill`, `goal`, aprovação de `memory`, `task wait`, outline do `code_graph`, forma da chamada de read, roteamento do Git, roteamento de browser/computer) ficam declaradas somente ali. A precedência é por papel: a última solicitação explícita do usuário para o Lead, o último briefing do Lead para os agentes. A regra de preâmbulo do Lead agora traz seu motivo (o usuário vê apenas o seu texto) e pede uma linha, não uma contagem de palavras; a regra de briefing diz que um agente nunca vê a conversa, que as descobertas são sintetizadas em caminhos, linhas e na mudança exata (nunca "com base nas suas descobertas") e que o resultado de um agente nunca é previsto. As regras de ações destrutivas que estavam espalhadas por quatro seções ficam em uma única seção `# Destructive Actions`. Os arquivos de papel (`agents/*/AGENT.md`) abandonam as frases de bloqueio/handoff que o contrato possui; `maintainer` ganha frontmatter de nome e descrição. Estilos de saída: o título `## Depth` substitui `## Depth Variation`, e a redação do relatório de progresso fica apenas nas regras do Lead. O workflow Default não traz mais o parágrafo de fallback do revisor; ele acompanha o bloco do modo de orquestração que os modos delegantes injetam. Descrições de ferramentas: `edit` não aponta mais para `apply_patch` em superfícies que o filtraram, `shell` diz que o Git vai para `git` apenas quando essa ferramenta está presente, `read`/`grep` abandonam limites de bytes que o runtime informa de qualquer forma, `code_graph` declara que `symbols` é o outline. Provedores que entregam eles mesmos o lembrete de rodada (`anthropic-oauth` como mensagem de sistema com escopo de turno, `cursor` por seu relay) declaram `deliversRoundReminder` para que o canal do runtime fique em silêncio — as sessões do Cursor não recebem mais o lembrete de agrupamento duas vezes por rodada. A verificação de procedência do aviso de agrupamento normaliza separadores de caminho e aceita um diretório mostrado como prefixo de um caminho mais profundo no resultado anterior, de modo que uma chamada seguinte sobre um caminho que o último resultado revelou não parece mais uma chamada única sem relação (dois falsos positivos por sessão antes). O esquema de rota de `setup` declara `contextPercent` como inteiro limitado (o executor ainda exige um múltiplo de 10) para que o Gemini deixe de receber um placeholder de enum irrepresentável. As expectativas de testes obsoletas deixadas pelo commit de agrupamento foram atualizadas, e dois testes dependentes de tempo/ambiente foram tornados determinísticos. A habilidade de projeto `gamerscroll-article` tem escopo restrito ao seu projeto.
- As releases do GitHub agora trazem como notas a seção do CHANGELOG.md da versão, seguida do link de comparação; o rascunho antes dependia das notas geradas pelo GitHub, que listam apenas PRs mesclados e deixavam a página com um link `Full Changelog` solto porque o Deploy faz commit direto na main.
- Agrupamento de ferramentas: após três rodadas de chamada única da mesma ferramenta em sequência cujas chamadas não dependiam umas das outras (nenhum argumento tirado do resultado anterior, nenhum passo ordenado depois de uma mutação; uma ferramenta diferente reinicia a sequência, então read → shell → apply_patch nunca é reportado; esperas de task, Computer Use, passos de browser e carregamentos de esquema/habilidade nunca contam), ou uma rodada de chamadas da mesma ferramenta que diferem apenas em um campo de array, o runtime acrescenta um breve `<system-reminder>` citando os argumentos de array da superfície de ferramentas da sessão; ele se repete sempre que o padrão reaparece e apenas uma rodada agrupada o limpa (registrado como `batching_nudge`). Um `read` de arquivo único logo após uma rodada de grep/code_graph/glob/find que localizou vários arquivos recebe de volta o conjunto localizado na forma que uma chamada `read` aceita (`[{file_path, offset, limit}, …]`; um read por arquivo na mesma resposta em provedores cujo esquema de read aceita apenas strings de caminho), registrado como `located_sites`: uma sessão registrada do Gemini 3.8 Flash localizou arquivos com grep 13 vezes e ainda os leu uma janela por vez (63 leituras, 20 de 28 arquivos lidos duas vezes ou mais). As descrições de `read` e `grep` agora dizem o que é o lote — todo arquivo e intervalo que você vai tocar, antes de editar, em uma só chamada — e o rodapé da leitura em janelas pede uma leitura mais ampla em vez da próxima janela. As regras compartilhadas agora declaram a ordem de trabalho em arquivos uma única vez (`# Tool Calls`: enumerar só quando o escopo é desconhecido → localizar todos os pontos → um estágio de leitura de janelas `{file_path, offset, limit}`, ≤10 por chamada → todas as edições em uma resposta → uma verificação) e eliminam as frases que antes diziam partes disso em três lugares; as descrições de `read`, `grep`, `edit`, `apply_patch` e `code_graph` encolhem para esse contrato (code_graph de ~150 para ~90 palavras), e o marcador de limite inteligente de uma leitura em janelas cita a forma de janelas localizadas; uma nova passada apara a prosa de parâmetros que repetia as regras ou detalhes internos (`Skill`, `find`, `cwd`, `git`, `code_graph.mode`, `grep.path`/`text`, `include_noise`, o guia rápido de PowerShell do shell e `timeout_ms`) — a superfície de ferramentas do Lead cai de 13.4 KB para 12.7 KB. Execuções de oito tarefas com o GPT-5.6 antes e depois permanecem em 8/8 com o mesmo envelope de rodadas, tempo e custo; a única regressão encontrada no caminho (uma rodada de backup para entradas somente leitura e levantamentos de `git log` depois que duas cláusulas de proteção foram cortadas) foi restaurada. A regra de backup agora diz para onde vai a cópia — na mesma resposta da primeira inspeção, nunca em uma rodada própria — porque "dentro da primeira chamada de inspeção" fazia o GPT-5.6 abrir 2.8 rodadas só de backup por execução de oito tarefas quando a primeira inspeção era uma chamada `read` ou `git`; com a redação corrigida, não abriu nenhuma e agrupou todo backup com essa inspeção. O lembrete serial não trata mais um array dentro de uma única chamada como um lote: uma revisão registrada do Gemini 3.8 Flash executou quinze rodadas de uma chamada, alternando chamadas `git` de um e de dois comandos, e nunca o recebeu porque toda rodada com array zerava a sequência. A verificação de procedência também lembra seis rodadas em vez de duas, de modo que uma lista de arquivos de `git diff --name-only` percorrida um item por rodada não faz mais cada item passar por algo que o diff anterior revelou. Mais dois lembretes do runtime: `late_locating` (uma busca depois de uma leitura que não tirou nada dela) e `located_sites` entregando uma janela por ponto localizado — incluindo as linhas `(Lstart-end)` do code_graph — divididas em várias chamadas read acima de dez. Os arquivos de política de rota (`rules/routes/*.md`) agora também declaram um `turn-reminder:` de uma linha (lido uma vez no bloco `<system-reminder>` final do turno do usuário, antes da primeira resposta do turno) e um `round-reminder:` de uma linha ao lado de suas regras estáticas; o loop do agente resolve este último por provedor/modelo e ele chega ao modelo depois de cada rodada de ferramentas — como mensagem de sistema com escopo de turno da Anthropic (`clear_at: next_user_message`) no `anthropic-oauth`, o padrão que a Anthropic documenta para o Claude Fable 5.1, ou como `<system-reminder>` do runtime após rodadas de chamada única nos demais (`per_round`). O lembrete do Fable 5.1 sai de uma constante de provedor fixa no código para os arquivos de rota; históricos gravados sob a frase anterior a reproduzem byte a byte. Um arquivo, `routes/common.md`, carrega os lembretes de agrupamento de todas as rotas (um arquivo sem restrição é a base; um arquivo que cita `models:` ou `providers:` acrescenta a essa linha para suas rotas em vez de substituí-la) — o Gemini vai de uma chamada por rodada assim que chegam os resultados das ferramentas, o Grok agrupa chamadas mas nunca usou argumentos de array: seus esquemas de ferramentas achatados mantinham só o ramo escalar de todo campo de um-ou-muitos (`read.file_path`, `grep.pattern`, `git.command`, …). O achatamento do Grok agora mantém o ramo de array desses campos (um valor viaja como array de um elemento) e diz isso na descrição do campo, de modo que o contrato de agrupamento vale também nesse provedor. As regras compartilhadas ganham uma seção `# Parallel Tool Calls` que declara o contrato com clareza (sessões registradas do Gemini 3.8 Flash emitiram uma chamada por rodada em 105/105 rodadas; com a seção no lugar, uma execução headless agrupou quatro arquivos e git em uma resposta). As regras vinculadas a provedor/modelo são carregadas de `rules/routes/*.md` por meio do frontmatter `providers:` / `models:` e renderizadas depois das regras compartilhadas em BP1. `MIXDOG_ANTIGRAVITY_DUMP_DIR=<dir>` grava todo corpo de requisição do Antigravity (conteúdo, ferramentas, config; nunca cabeçalhos nem tokens) para inspeção do protocolo, o equivalente Gemini de `MIXDOG_OAI_WS_DUMP_DIR`; `mixdog exec` também repassa `MIXDOG_XAI_CACHE_TRACE` e `MIXDOG_XAI_RESPONSES_CACHE_SCOPE` para sondagens de cache da xAI.
- As requisições Responses da xAI não enviam mais um `prompt_cache_key` por sessão por padrão (`MIXDOG_XAI_RESPONSES_CACHE_SCOPE` agora tem `none` como padrão, o corpo literal do Grok Build): a chave de sessão dividia o cache do serviço em faixas e media duas rodadas frias por execução contra uma, e nenhum reaproveitamento de prefixo entre sessões. `session` e `prefix` continuam selecionáveis. `MIXDOG_ANTIGRAVITY_FC_MODE=AUTO|ANY|VALIDATED` substitui o modo de chamada de funções do Antigravity em execuções de A/B, e `benchmarks/terminal-bench-2.1/analysis/tool-batching-by-model.mjs` informa as taxas de múltiplas chamadas e de argumentos de array por modelo a partir de `agent-trace.jsonl`.
- `mixdog exec` vincula a conta OAuth selecionada no pool de contas de provedores do host (a credencial que o login grava hoje), recorrendo ao único arquivo de credencial legado; antes só o arquivo legado ou um `*_CREDENTIALS_PATH` explícito era aceito, então hosts apenas com pool falhavam com "credentials are unavailable". `mixdog exec` também não fica mais 2–4 minutos além da resposta antes de emitir `result`: a remoção da raiz limpa repetia tentativas no Windows por todo o orçamento do rmSync (50 tentativas lineares ≈ 128s, duas vezes quando o caminho do postmaster a reexecutava) enquanto o handle SQLite do ledger de uso e o `pg.log` de um daemon de memória em encerramento ainda estavam abertos. O ledger é fechado antes da remoção e o exec passa um orçamento de 10 tentativas (≈5.5s) (`cleanup({ rootRemovalRetries })`); uma raiz retardatária é deixada para a varredura periódica de órfãos em vez de para quem chamou.

## v0.9.169 - 2026-09-16

- Code Tidy: Instalar agora baixa os mecanismos principais (Biome, ruff, shfmt, shellcheck, PSScriptAnalyzer) com progresso, e o cartão integrado lista cada mecanismo com sua versão, linguagem, origem e tamanho; mecanismos descobertos depois por um projeto aparecem na mesma lista. Os mecanismos ausentes na hora do tidy são baixados automaticamente por padrão (`tidy.downloads` ainda respeita `ask` e `never`). O PSScriptAnalyzer é um download gerenciado, verificado por sha256, da PowerShell Gallery, em vez de um módulo apenas do host, e o C# ganha um runner de dotnet-format de verdade. Correções: os cabeçalhos de diff do rustfmt 1.9 e os caminhos `\\?\` são interpretados, relatórios grandes do Biome não colapsam mais para zero achados quando a saída vem em blocos, a possibilidade de correção é classificada por meio de `biome explain`, e a regra de comentários de histórico só remove comentários inteiramente de histórico e nunca passa do comentário (ela podia apagar a instrução seguinte).
- As linhas da barra lateral compartilham uma etiqueta de status ao lado do título em integrados, plugins, habilidades, servidores MCP, agendamentos, webhooks e agentes: nada quando ativado; do contrário `Not used` (Não utilizado), `Not installed` (Não instalado), `Installing… N%` (Instalando… N%), `Failed` (Falhou) ou `Not connected` (Não conectado). Agentes desativados mantêm a linha de modelo.
- O FastDirect se recusa a reempacotar ou instalar um `app.asar` cujo fechamento de dependências de produção está incompleto e recorre a um build completo, de modo que um atualizador quebrado (`Cannot find module 'graceful-fs'`) não é mais herdado por toda atualização incremental.
- Workers de agentes que foram coletados não são mais ressuscitados por varreduras de sessão nem pela lista de agentes do desktop; sessões concluídas e registradas de novo mantêm o horário real de término, de modo que as concessões expiram em vez de reiniciar a cada hora.
- Os modos de orquestração `none`, `focused`, `balanced` e `swarm` substituem o workflow Solo e são escolhidos por sessão; as configurações estão localizadas.
- Desktop: links de caminhos locais em markdown abrem no editor, e o editor abre arquivos fora do projeto.
- O Browser Use serializa os snapshots por página e reforça os caminhos de estabilização e captura.
- Computer Use: um renderer de overlay congelado é aposentado e substituído, o estado de recuperação de entrada sobrevive à troca, e as fixtures do overlay não saem mais cedo em uma máquina de tela única.
- Shell: os hosts PowerShell não bloqueiam mais `grep`, `sed` e `awk` no preflight; a descrição da ferramenta roteia o trabalho para as ferramentas dedicadas. Regras, habilidades, README e o novo `docs/context-efficiency.md` foram atualizados.
- O repositório é formatado com Biome 2.5.13 (`biome.json` fixa o estilo existente), rustfmt, dotnet-format e PSScriptAnalyzer; imports não usados, helpers mortos e exports usados apenas no próprio arquivo foram removidos.

## v0.9.168 - 2026-09-16

- Fechar uma sessão do Computer Use sempre envia sua própria requisição de liberação. A liberação especulativa do temporizador de inatividade costumava ser herdada enquanto ainda estava em andamento, de modo que uma liberação antecipada recusada podia deixar o worker e as reservas de janela da sessão que estava fechando presos até o app reiniciar.

- Overlay do Computer Use: dois controles, Parar e Retomar. O botão de pausa foi removido (tocar na área de trabalho já passa o controle ao usuário); a pílula agora mostra por que um controle não está disponível ou por que uma requisição falhou, em vez de reagir em silêncio. Parar recupera uma falha de limpeza travada assim que todos os workers de entrada saíram, de modo que o host não precisa mais reiniciar o app, e a confirmação de saída do worker espera até 5 segundos em vez de 1.
- O Computer Use captura uma janela a partir da própria superfície renderizada, em vez de copiar a área de trabalho, com um orçamento de captura limitado; uma liberação de recurso não confirmada aposenta aquele worker. Teclado e digitação em segundo plano são verificados antes de qualquer entrada ser enviada, de modo que uma rota não compatível não faz nada. Um novo comando espera até que a liberação da sessão anterior seja confirmada. Parar também espera o cancelamento do turno do agente, independentemente da limpeza de entrada nativa.
- As esperas do Browser Use respeitam o cancelamento e se recusam a misturar uma URL com texto de um documento posterior; uma restauração falha de captura de tela da página inteira é terminal. Os seletores CSS mantêm espaços internos, recusam conjuntos de correspondências grandes demais e endereçam cada correspondência de modo único. Downloads simultâneos compartilham um total de bytes por sessão; os pedidos de aprovação descrevem ações e endereços, nunca valores de formulários.
- O Code Tidy é um recurso integrado instalável, como o Office: Configurações → Integrado o instala e o ativa ou desativa, e a habilidade `code-tidy` conduz a ferramenta `tidy`. A varredura detecta as linguagens de um projeto e resolve cada formatador ou linter a partir da configuração do projeto, depois dos binários locais do projeto, do PATH ou de um download gerenciado verificado por sha256 (ask, auto ou never). Ele executa Biome, ruff, clang-format, shfmt, shellcheck, StyLua, gofumpt, dprint, Air e Mago, além de rustfmt, gofmt e PSScriptAnalyzer da toolchain, e aplica pacotes estruturais (remoção de comentários de histórico, `debugger`, catch vazio, marcadores TODO) em 31 linguagens. `fix` é uma simulação, a menos que apply esteja definido, e as gravações passam pelo mesmo pipeline das outras edições. As licenças dos mecanismos acompanham a ferramenta.
- Os chamadores e chamados de `code_graph` vêm de pontos de chamada analisados, e não de busca por texto; referências em forma de chamada também usam esses pontos. Um binário de grafo mais antigo que não consegue emiti-los falha com uma indicação de reconstrução em vez de uma resposta vazia. As linhas do outline usam um único vocabulário de tipos, marcam exports, mostram assinaturas e aninham membros sob o pai. `find_symbol` prefere um arquivo de implementação a um `.d.ts` acompanhante e informa quando a declaração está fora dos arquivos solicitados. Os tokens de identificadores vêm da árvore de análise, de modo que um nome que aparece apenas em um comentário não conta mais como referência. Solidity, Haskell e HCL entram no conjunto de extração com arestas de import (24 linguagens de extração, 31 analisadas). Os dados de pontos de chamada ficam em um cache auxiliar para que o cache principal do grafo mantenha o mesmo tamanho.
- O binário nativo do grafo incorpora tree-sitter 0.27 e ast-grep 0.45.3, adiciona os modos `--scan`, `--langs` e `--outline` e extrai símbolos, imports e tokens de identificadores a partir de regras YAML.
- O outline de fallback do grafo no editor do desktop interpreta as novas linhas de símbolos em um outline aninhado com ícones de tipo.
- As perguntas de estrutura (exports, assinaturas, membros, chamadores, importadores) vão para `code_graph` antes de `read` ou `grep`; a redação de paralelismo do fluxo de ferramentas virou uma só regra.
- A manutenção da memória não promove mais resumos de conversa a instruções permanentes: não há um terceiro ciclo. O ciclo 2 revisa o histórico de busca em busca de duplicatas e linhagem sem reescrever resumos. A memória permanente continua curada pelo usuário por meio de `memory`; `recall` pesquisa todo o histórico por padrão, inclusive linhas arquivadas anteriormente.
- O uso do Antigravity Gemini mostra as janelas compartilhadas de 5 horas e semanais do resumo de cota da conta, e não contadores de catálogo por modelo, e as requisições usam o canal diário sem failover automático de host.
- O painel Agentes expande apenas as linhas que você abre, mostra a contagem de descendentes no lead e diz "Waiting for agents" enquanto os descendentes ainda trabalham, em vez de tratar o pai como ocioso ou concluído.
- O campo de redação oferece uma pequena paleta de comandos com barra para os comandos frequentes (`/new`, `/model`, `/compact`, `/context`, `/goal`, `/inherit`, `/fast`); o registro completo continua funcionando quando digitado diretamente.
- As menções de arquivos na conversa permanecem texto simples até o caminho ser confirmado no Projeto dono; pastas e documentos ainda abrem no sistema operacional, e as aberturas do editor passam um token de acesso.
- A lista de uso na barra lateral alinha rótulos de provedores, medidores, porcentagens e horários de redefinição em uma única grade; o catálogo de modelos mantém sete recentes.
- Uma nova sessão espera as gravações de configurações pendentes terminarem, e as ferramentas MCP que saíram do catálogo atual não são chamadas no meio de um turno.

## v0.9.167 - 2026-09-15

- O início da sessão informa quais ferramentas comuns de shell estão presentes ("Shell tools at startup"), medidas no shell de login no POSIX e no PATH do processo no Windows, de modo que um modelo não adivinha mais `python` contra `python3` nem chama `file` onde ele não existe; uma resposta desconhecida não renderiza nada.
- `read` renderiza uma vez as janelas sobrepostas de um mesmo arquivo, não informa mais intervalos de edição não lidos como já entregues e nunca herda uma marca obsoleta de corpo inteiro entregue depois que um arquivo muda; as leituras em array respeitam a opção de não usar stubs e a descrição declara os limites reais de saída.
- `git` executa comandos encadeados com `&&` como um array ordenado (até 10) em vez de rejeitá-los, e reconhece repositórios bare.
- O cache de leitura da sessão respeita a lista de ferramentas permitidas, detecta mudanças apenas de `ctime`, nunca armazena um corpo capturado antes de uma mudança no meio da leitura, mantém separadas as dicas de offset públicas e legadas e cobre leituras públicas em array.
- Os arrays de `web_search` mantêm falhas parciais e totais sinalizadas como erros.
- As regras e as descrições das ferramentas integradas ficaram mais curtas com o mesmo comportamento: a descrição de `shell` traz o mapa comando→ferramenta e proíbe nomes de ferramentas como comandos de shell; a orientação de `timeout_ms` cobre verificações descartáveis; a orientação do Lead que só se aplica com a ferramenta `agent` é omitida dos workflows sem delegação; as regras pedem, em uma resposta, toda ação independente que a evidência atual exige, correção direta a partir de evidência decisiva, uma amostra antes da lógica de análise e recortes limitados para dados grandes ou binários.
- O runtime do desktop foi sincronizado com o trabalho atual dos harnesses de browser e computer, e os testes de contrato das ferramentas foram reforçados de acordo.

## v0.9.166 - 2026-09-14

- O Studio reconhece a conta do ChatGPT selecionada após o login do provedor e as trocas de conta, usando o mesmo caminho de credenciais do chat, sem recorrer às credenciais de outra conta.

## v0.9.165 - 2026-09-14

- O dock de Controle de Código-Fonte mantém sua janela de linhas vinculada à lista ativa: um dock reconstruído (troca de aba, da superfície de primeira execução para a lista) não rola mais para linhas vazias.
- Os recursos de release do macOS são enviados pelo script de excluir-e-tentar-de-novo nas duas arquiteturas, de modo que uma execução de recuperação não falha mais por um recurso que já existe no rascunho oculto.
- Portão de release: toda faixa passa em verde nos runners hospedados. O Linux instala a NanumGothic para PDFs em Hangul e o LibreOffice atual para revisões renderizadas; a verificação do cursor no Windows fixa sua preferência de movimento; as expectativas dos testes seguem os contratos distribuídos.

## v0.9.164 - 2026-09-14

- Compactar as regras compartilhadas e do Lead e as descrições das ferramentas integradas para o mesmo comportamento com menos tokens; a descrição de `shell` mantém apenas seu papel, a fronteira com as ferramentas dedicadas de arquivos/busca/Git e o contrato de tarefas em segundo plano.
- As execuções headless (`mixdog exec`) declaram que nenhum usuário intervém no meio da execução: a requisição é tratada como aprovada e levada até o fim antes de relatar, em vez de parar para fazer uma pergunta que ninguém pode responder.
- `apply_patch` digitado no shell não é mais redirecionado ao mecanismo de patch; o modelo chama `apply_patch`/`edit` diretamente.
- Um Goal interrompido se aposenta como um concluído: o próximo prompt do usuário o arquiva, e confirmar uma interrupção o arquiva de imediato.
- As estatísticas de uso atribuem tokens e custo medidos por requisição no ledger, e o explorador de uso do desktop mostra a divisão resultante.
- Correções no protocolo do provedor Cursor.

## v0.9.163 - 2026-09-10

- Refinar a localização da interface, a seleção do idioma de inicialização, os menus nativos e a formatação traduzida; manter atualizado o bootstrap de idioma da web entre atualizações.
- Reforçar a propriedade da entrada do Computer Use e as verificações somente de observação, confirmar os alvos de texto do Electron antes de digitar e melhorar o tratamento do cursor e das sessões.
- Melhorar a busca nativa de arquivos e as leituras por intervalo, e impedir que cálculos em andamento invalidados ou cancelados repovoem o cache de resultados.
- Incluir benchmarks de busca, cobertura de regressão, auditorias de localização e entregáveis gerados de projetos e documentos.

## v0.9.162 - 2026-09-09

- A caixa de diálogo Defina uma meta abre centralizada no painel cujo campo de redação a acionou, escurecendo apenas esse painel; os painéis vizinhos permanecem visíveis e utilizáveis e a barra de título não é mais escurecida. Fora de um painel, recorre à camada da janela.
- Um painel em foco não cobre mais a alça de divisão da própria borda: um painel de navegador (ou qualquer painel em foco) pode ser redimensionado de novo pela borda esquerda/superior.
- O web fetch informa um estágio que expira no prazo total como `FETCH_TIMEOUT` em vez de `STAGE_TIMEOUT`.
- O Computer Use usa por padrão a entrega em segundo plano para entradas semânticas compatíveis; `foreground_unavailable` agora pede ao usuário que ative a janela de destino em vez de descrever uma falha de bloqueio de primeiro plano.
- A execução de release da v0.9.162 parou no portão de testes e não publicou nada; suas notas abaixo são entregues por esta release.

- O Mixdog agora é licenciado sob Apache-2.0 em vez de MIT. Os componentes de terceiros mantêm suas licenças e avisos de atribuição existentes.

- O Browser Use e o Computer Use pedem uma vez por sessão antes da primeira chamada ao vivo. A primeira chamada `browser`/`browser_devtools` ou `computer` que um modelo faz em uma sessão passa pelo pedido de aprovação de ferramentas com a ação que ele quer executar; permitir cobre o resto da sessão, recusar devolve o motivo ao modelo com a instrução de não tentar de novo, e uma reinicialização pergunta de novo. Sessões sem interface de aprovação (headless, de propriedade de agentes) não são barradas. `setup set_first_use_approval name:browser|computer enabled:false` desativa isso por capacidade, e `MIXDOG_BRIDGE_FIRST_USE_APPROVAL` substitui por processo.

- O Browser Use dobra dois gestos nos vizinhos. Uma caixa de seleção ou botão de opção é definido por `fill` com `checked` em vez de `text` — para um controle, um item de `fields` ou um passo de `sequence` — de modo que a ação `check` separada foi removida; e `forward` foi removido, pois o snapshot anterior já mostrava a URL para `navigate`, enquanto `back` continua sendo um gesto. `locate` e `extract` permanecem: o primeiro é uma busca visual (por pixels) sem equivalente semântico, o segundo lê linhas entre frames e shadow roots abertos que `evaluate` não alcança.

- O `capture` do Computer Use abandona os parâmetros `quality`, `maxWidth` e `max_ocr_words`: valem os padrões ajustados do host (qualidade JPEG, largura de redução e um limite de palavras de OCR que o orçamento de elementos já limita), e um detalhe ilegível é um `zoom`, e não uma nova codificação. Os filtros de elementos (`query`, `role`, `visible_only`, `include_noninteractive`, `continuation`) e a geometria de movimento de `window` agora dizem o que fazem, em vez de viajar no esquema sem explicação.

- O Browser Use e o Computer Use declaram seu degrau na escada de ferramentas onde o modelo decide. A descrição de `browser` abre com "last resort: prefer web_fetch, an MCP tool, or a CLI in shell", `computer` com "last resort after an MCP tool, shell/CLI, and Browser Use; never a stand-in for a page action browser refused", e as regras compartilhadas e as duas habilidades trazem a mesma escada, de modo que um serviço que tem API ou CLI é alcançado por ela, e não por uma tela. Nenhuma descrição cresceu: a escada substituiu redação que as habilidades já possuíam.

- O Browser Use passa a ser duas ferramentas. `browser` mantém o trabalho cotidiano com páginas — navigate, snapshot, read, click, fill, formulários, diálogos, abas, downloads, leituras de console e de rede — enquanto os controles de desenvolvedor `emulate`, `cookies`, `storage`, `intercept`, `init_script` e `performance` passam para a ferramenta adiada `browser_devtools`, que conduz as mesmas páginas e logins e carrega seu esquema na primeira chamada. O esquema cotidiano abandona os 33 campos que só essas ações usavam (atributos de cookie, geolocalização, limitação de CPU, corpos de interceptação, opções de trace), as notas de campo de cada ferramenta citam apenas as próprias ações, e uma chamada que chega à ferramenta errada é recusada com a indicação da ferramenta a chamar. O host, seu registro de ações, a política de aprovação e o harness de integração mantêm o contrato único e compartilhado de ações.

- Os esquemas das ferramentas integradas declaram apenas contratos. As descrições e notas de campo das ferramentas `office`, `computer`, `media` e `setup` abandonam as frases de método e política que suas habilidades já possuem — agrupamento, quando fazer snapshot ou `describe`, corrigir uma auditoria no mesmo turno, reutilização de `design.content`, tratamento de macros, não reorganizar, conteúdo da tela nunca autorizar uma ação, polling de vídeo, o procedimento de aprovação de exclusão — o que remove cerca de 2.2 KB (office −878 B, computer −492 B, media −432 B, setup −424 B) da superfície de ferramentas enviada a cada turno. As habilidades pptx, xlsx e pdf agora carregam as regras que viviam apenas no esquema (um lote de operações conhecidas, `describe` só para um campo desconhecido, conteúdo de documento não confiável), e a habilidade computer-use declara o contrato de chamada uma vez, em vez de repetir cada frase do esquema.

- O Browser Use precisa de menos chamadas por tarefa. `click`, `fill`, `type`, `select`, `hover`, `upload` e `scroll` — e todo item de `fill.fields` e passo de `sequence` — aceitam um `target` sem snapshot (`{role, name}`, `{name}` ou `{selector}`) em vez de uma `ref`: o host observa a página por conta própria, age apenas sobre exatamente uma correspondência (várias correspondências por substring se resolvem na única literal), e um alvo ambíguo falha com os candidatos e suas refs novas. `query` em `snapshot`, `read` e `wait` casa palavras-chave separadas por espaço com OR (as correspondências de todas as palavras vêm primeiro) e aceita expressões regulares `/pattern/i`, e um filtro que não casa com nada diz quantos elementos ou caracteres estava filtrando. Controles transparentes ou com pointer-events:none não são mais recusados de imediato: uma caixa de seleção oculta é clicada por meio do seu rótulo, e a proteção do alvo de entrada aceita a ativação do rótulo. `fill` em um editor `contenteditable` substitui o conteúdo como entrada digitada sobre um selecionar-tudo, em vez de sobrescrever seu DOM. As respostas indicam "No observable change" quando um gesto deixou o documento, a URL e os valores dos controles intactos, `brief:true` lista apenas elementos novos ou alterados desde a observação anterior, os erros de console são informados uma vez quando novos, e uma pós-condição que já valia é um aviso, e não um erro. Os snapshots marcam campos de arquivo com `file-input`, `accept=…` e `multiple`; as capturas de tela da página inteira ancoram elementos fixos e sticky no fluxo durante a captura; e os cookies de sessão são armazenados criptografados com o chaveiro do sistema e restaurados na inicialização, de modo que os logins sobrevivem a uma reinicialização do app.

- A área acima do campo de prompt — cápsula de Objetivo, progresso do runtime, aprovação de ferramentas, barra de contexto do rascunho e o espaço da revisão do turno — agora vive em um único `ComposerDock`, e a transcrição não balança mais quando essa área termina de carregar: o espaço da revisão permanece reservado enquanto a primeira leitura autoritativa do worker de um escopo está em andamento, de modo que um diff que chega depois de a transcrição ser exibida preenche a geometria existente em vez de redimensionar o viewport de novo. O espaço liberado nunca é mantido por um temporizador. O host do desktop também deixa de reler uma sessão inteira após cada prompt aceito (a recuperação "missing baseline" do log do daemon): um quadro de resposta ou de faixa que repete a revisão que a projeção já tem é estado aplicado, e não uma base cruzada. As alternâncias de montagem/desmontagem da cápsula de Objetivo são atribuíveis com `MIXDOG_DESKTOP_PERF=1`.

- Uma cápsula de Objetivo não surge e some mais sozinha. Dois caminhos de publicação produziam o pisca: o pulso de rota de 2s lia o registro bruto do Goal enquanto o arquivo de entrada do usuário de um Goal concluído ainda estava sendo gravado, de modo que a cápsula encerrada voltava por um quadro; e no Windows uma leitura do Goal que caía dentro da substituição atômica do arquivo (`EPERM`/`EACCES`/`EBUSY`, ou a própria gravação em andamento do runtime) aparecia como "no Goal" naquele quadro. As publicações de rota agora leem o Goal pela máscara de arquivo da continuação do goal, e o armazenamento de Goal responde a essas leituras a partir do último registro confirmado.

- O Browser Use não para mais para pedir aprovação: a caixa de diálogo "Permitir uma vez" do desktop que protegia `upload` e o `clear` compartilhado de cookie/localStorage foi removida, o campo `confirm` sai do contrato da ferramenta de navegador, e a habilidade browser-use abandona suas regras de autorização na conversa. `MIXDOG_BROWSER_CONFIRM_ACTIONS` e `MIXDOG_BROWSER_DENY_ACTIONS` continuam sendo a única forma de confirmar ou recusar ações nomeadas.

- A coluna de leitura do painel — campo de redação, transcrição e o dock do Studio — não espera mais um painel de 1536px se alargar: a partir de 768px ela mantém 800px até o painel passar de 1000px, depois acompanha 80% do painel até o teto de 1000px em 1250px, de modo que janelas de 1536/1680 e 1920 com um painel lateral aberto deixam de ficar estacionadas em 800px, e um divisor cruzando o degrau não estala mais a coluna em 200px.

- O painel Sessões abre com duas linhas fixas de lançamento, `New task` (Nova tarefa) e `New Studio` (Novo Studio), fixadas acima da lista de sessões. O Studio, portanto, sai da barra de atividades: sua entrada apenas de lançamento na barra e as exceções de lançador no layout da vista lateral, no dock do painel e nas alternâncias do dock foram aposentadas, e um layout de barra armazenado descarta o id `studio` ao carregar.

- O destino Workflows da barra de atividades se funde ao painel Projetos: uma barra de ferramentas `Project | Workflow` — a chave de seção do painel Extensões, agora compartilhada como um único componente `SidebarSectionToolbar` — alterna entre a lista de projetos e os pacotes de workflow, agentes padrão e definições de agentes; o `+` do cabeçalho acompanha a aba Projeto; `/workflow` e `/websearch` abrem a aba Workflow; e um layout de barra armazenado descarta a vista `workflows` aposentada ao carregar.

- O kit da habilidade pptx ganha um vocabulário de design no estilo dos sistemas de design baseados em tokens: `palette()` deriva três intensidades de linha (`lineSubtle`, `line`, `lineStrong`) e quatro cores de estado (`T.state.positive | warning | critical | informative`, cada uma como `solid` / `weak` / `text`, com contraste garantido e mantidas abaixo da faixa saturada do revisor, para que uma coluna de veredito nunca dispare `accent_hue_overuse`); toda distância fica em uma única escada de espaçamento (`SPACE`) nomeada por relação (`GAP.bind` / `within` / `between`, `GUTTER`, `PAD`, `M`); cada papel de texto carrega um entrelinha fixo; os portadores repetidos (selo, callout, sequência de chevrons, estatística, tabela) leem sua anatomia de `SPEC` com variantes de `tone`, um degrau de escala de `stat` e um auxiliar `statBand()`; os ícones mapeiam para quatro faixas de tamanho; e um novo `references/writing.md` fixa regras de frase, registro, número, data, dinheiro, unidade e espaço para tradução, com link a partir das habilidades docx e xlsx. Cada portador de spec assina sua forma, e o recibo de composição lê as assinaturas de volta (`slides[].specs`, `deck.specs`: contagem, slides, variantes, anatomias), de modo que um portador cujo tamanho de tipo ou face divergiu entre slides aparece como uma segunda anatomia.

- Os tokens de design do Office derivam as mesmas quatro cores de estado (`positive`, `warning`, `critical`, `informative`, cada uma com um campo `Weak` e um degrau `Text`, com contraste verificado contra a tela, o painel claro e o campo); os portões de decisão de docx e xlsx desenham Liberar e Parar nos estados positivo e crítico em vez de um tom literal e do segundo destaque, e o `calloutTone` da seção de um `compose_document` coloca seu callout em um estado. A área de impressão do dashboard de um `compose_sheet` agora acompanha o painel de decisão, de modo que um portão Stop em uma coluna além da tela não é mais cortado da página renderizada e exportada.

## v0.9.161 - 2026-09-06

- As auditorias do Office medem Arial, Helvetica, Times New Roman, Courier New, Calibri, Cambria e Georgia em suas fontes abertas com métricas compatíveis (Liberation, Arimo/Tinos/Cousine, Carlito, Caladea, Gelasio) sempre que a original não está instalada, em vez de informar a fonte como indisponível e aproximar o ajuste — uma máquina Linux com as fontes Liberation agora audita uma apresentação como o Windows. O pacote raiz ganha as faixas `test:slow` e `test:live`, e as faixas de runtime do CI instalam as fontes Liberation.

- Os commits do Controle de Código-Fonte recebem um resumo digitado à mão e uma descrição opcional: predefinições de mensagem de commit, verificações de formato, autocompletar e geração por IA saem do cartão Git e GitHub e do formulário de commit, e as preferências legadas `desktop.git` não são lidas nem gravadas.

- O Computer Use abandona o editor de autorização do lado das configurações (bloqueio de janela e de ação, expiração): ele permanece irrestrito por padrão, com as proteções permanentes — proteções de entrada, tratamento de elevação, tomada de controle pelo usuário, proteções de ambiente — e um arquivo de autorização salvo não pode mais expirar e causar um bloqueio. A restrição em processo continua para um host incorporador por meio de `MIXDOG_COMPUTER_POLICY_FILE` e `host.updateAuthorization`, nada é persistido, e a exportação de diagnóstico de falhas permanece. A ferramenta ganha `wait_for_user`: quando o usuário assume o controle, o modelo espera por um intervalo limitado e captura um estado novo depois, em vez de adivinhar permissões.

- Todo cartão de Extensões e de Integrados abre a mesma caixa de detalhes — placa de identidade e título, seções em um mesmo ritmo, um rodapé com uma hierarquia de ações, com a ação destrutiva à esquerda, um único estilo de botão de ação — e as caixas de adicionar/editar de Projetos se juntam a ela. O cartão Git e GitHub carrega a conta do GitHub (login do gh por código de dispositivo); o cartão Local Provider lista os modelos instalados com tamanho, contexto e estado de execução, uma seção de carregamento de modelo para descarregar quando ocioso, e fatos ao vivo (build do runtime, GPU, memória livre, servidor), enquanto reparo e verificação continuam conduzidos pelo chat por meio da habilidade local-provider. Os fatos de status/plataforma saem das caixas porque o controle do cabeçalho e o selo da lista já os dizem. As folhas de estilo das extensões se dividem em `extension-list.css`, `extension-dialog.css`, `extension-editors.css` e `rail-controls.css`.

- Goal: retomar um Goal pausado e iniciar sua tarefa aprovada são uma só gravação durável — `resume` aceita atualizações e adições de tarefas, marcar uma tarefa como `in_progress` retoma o Goal, e a simples contabilidade nunca concede aprovação. O estado de um Goal pausado chega ao modelo quando a requisição é preparada, depois da hidratação, em vez de um lembrete único na resposta do usuário, de modo que nenhum turno pode perder o fato de que um Goal está esperando.

- Os celulares sincronizam suas visualizações ao reconectar: após o handshake seguro, o navegador pede ao desktop uma base consistente de suas sessões abertas (snapshot, lista de sessões, pool de agentes, estados das sessões) e as publicações ao vivo ficam retidas até ela chegar, de modo que um celular reconectado não pinta mais uma transcrição obsoleta nem perde o final de um turno. A transcrição entregue aos celulares omite o material de replay do provedor, tanto em deltas quanto em bases.

- A criação de nova tarefa sobrevive a uma conexão remota interrompida: cada requisição carrega um recibo durável, de modo que uma nova tentativa após um timeout ou reconexão cai na mesma sessão reservada em vez de criar uma duplicata, e o observador do armazenamento de projetos se recupera sozinho e reconcilia o catálogo enquanto está fora do ar.

- Conversas e faixas de abas aparecem sem salto: uma transcrição visitada é exibida quando suas linhas visíveis e o deslocamento final concordam entre quadros (limitado a um segundo, para que streaming ou uma fonte lenta nunca a esconda), e uma faixa de abas decide o overflow pelo layout de destino, e não por uma aba pela metade do crescimento.

- As ações do catálogo do Local Provider (`searchLocalProviderModels`, `inspectHuggingFaceModel`, `registerHuggingFaceModel`) existem na superfície de sessão em que o daemon as resolve, de modo que uma chamada de setup roteada pelo desktop não falha mais como ação de sessão indisponível.

- Os catálogos de idioma da interface do desktop voltaram a ficar em sincronia com o renderer: as strings que as vistas de controle de código-fonte e os comandos com barra leem por `t()` estavam ausentes de todos os catálogos (a aba aparecia como "History" em coreano), as frases em coreano do pacote de tradução legado aposentado foram migradas para `ko.json`, de modo que rótulos dinâmicos ("Ln 42", "Callers of …") voltam a ser traduzidos, e as strings dos menus nativos e das caixas de diálogo são geradas a partir dos mesmos catálogos. O coreano está completo; os outros dez idiomas recorrem ao inglês nas frases mais novas até que sejam traduzidas.

- O build do importador de navegadores substitui um checkout upstream pela metade em TEMP em vez de falhar nele. Harness de testes: as suítes do renderer podem importar módulos que puxam uma folha de estilo de recurso (um import `.css` é resolvido como módulo vazio no Node), a verificação de import do daemon do artefato construído roda na faixa live depois de um build, e as fixtures de caminho do armazenamento de configurações são resolvidas na gramática de caminhos do próprio host.

- A habilidade pdf e o runtime adotam a disciplina de inspecionar primeiro das habilidades de PDF de referência. Leitura: um snapshot informa `encrypted` e `passwordRequired` em vez do erro próprio do pdf-lib, `open`/`snapshot` com `password` leem o texto de um arquivo bloqueado nessa chamada sem guardar a senha, toda edição em um arquivo criptografado aponta para `secure` → decrypt, as páginas carregam seu tamanho e rotação, os marcadores voltam em `outline` com a página que cada um abre, e a extração de texto (snapshots do office, anexos do chat, a ferramenta read) mantém as quebras de linha como newlines, de modo que parágrafos e linhas de tabela sobrevivem. Formulários: os campos expõem o tipo `text|checkbox|radio|dropdown|optionlist`, `options`, `readOnly` e `multiline` de que um preenchimento precisa; `fill_form` nomeia um campo ou opção desconhecidos junto com o que existe e informa `filled`; `add_form_field` e `create` aceitam `optionlist`, `required`, `readOnly`, `maxLength` e `fontSize`; o lint sinaliza uma caixa pequena demais para uso (`formIssues` no create, `field_too_small` em `issues`); `preview_fields` grava uma cópia com cada campo e qualquer caixa proposta contornados e nomeados, para que uma renderização mostre o posicionamento antes de um preenchimento; um dropdown ou lista com opções em coreano não falha mais na criação porque o widget é pintado com a fonte incorporada desde o início; e um campo multilinha usa 11 pt por padrão em vez do tamanho automático do pdf-lib, que desenhava a primeira linha enorme e descartava o resto. Fontes: `create`, `add_text`, `watermark`, `fill_form` e OCR incorporam por conta própria uma fonte Unicode instalada quando o texto é coreano, CJK, cirílico ou grego (`pdf-fonts.mjs`; `fontPath` ainda escolhe; `detect` nomeia a fonte como `portable.pdfUnicodeFont`). Escrita: `create` quebra prosa sem espaços por caractere, respeita `\n`, quebra células de tabela e aumenta as linhas, repete o cabeçalho após uma quebra de página, numera saídas de várias páginas e aceita `columnWidths`, `level` de título, `align` de imagem, `orientation`, `footer` e mais tamanhos de página. Edição: `merge_pdf` aceita `sources:[path | { path, pages, title }]`, `index` e `bookmarks:true`; `add_bookmark` grava uma entrada de outline; `extract_pages` grava em `output` e `split_pages` um arquivo numerado por página ou a cada `every` páginas sem tocar o documento da sessão; `extract_attachment` faz round-trip de arquivos incorporados; `rotate_pages` soma à rotação atual; `delete_pages` mantém uma página; `compress` informa `bytesBefore`/`bytesAfter`; `add_text` aceita `align:'center'|'right'` e numera um arquivo existente por meio de `{page}`/`{pages}`; `highlight` marca cada correspondência de `find` (ou uma caixa; `wholeWord`, `regex` e `first` a restringem) com uma marca de mesclagem multiply que deixa o texto legível; `add_link` coloca um link invisível sobre uma correspondência que abre uma URL ou outra página, ou com `urls:true` faz todo endereço http(s) no texto abrir a si mesmo; `stamp_image` se ajusta dentro das margens, a menos que seja dimensionado; `issues` não informa mais uma página escaneada duas vezes e nomeia conteúdo ativo (`active_content`: JavaScript, Launch, ações ao abrir, links para arquivos ou outros esquemas que não são da web) sem segui-lo. Análise: `pdf-layout` com `query` retorna apenas as correspondências com suas caixas; suas caixas de texto acompanham a sequência em páginas giradas e em texto diagonal, e ele e o snapshot informam `origin` quando a caixa de uma página não começa em 0,0. As marcas de `find` invertem a transformação de exibição para tratar tanto deslocamentos de origem quanto rotações de página de 90/180/270 graus sem reorientar o documento; `first:true` preserva a ordem das linhas do documento em toda rotação. O layout lista os links de cada página (`url` ou a `page` de destino) e acrescenta as linhas (`lines`) e `boxes` (pequenos quadrados sinalizados como `checkbox`) de cada página, o que é necessário para preencher um formulário sem campos; `pdf-tables` lê uma tabela com bordas a partir dos retângulos de suas células (`source:'ruled'`, células quebradas intactas) antes do palpite de alinhamento de texto (`source:'alignment'`) e grava um CSV por tabela quando `output:<dir>` é dado, como `pdf-images` grava arquivos PNG e informa onde cada imagem fica na página; o OCR ajusta cada palavra invisível à sua caixa para que a camada de texto mantenha espaços simples. As prévias de página (`render`, `qa`, `finalize`) entregam ao pdf.js suas fontes padrão empacotadas, de modo que uma página em Helvetica ou Times não é mais renderizada com espaçamento entre letras. O adaptador é dividido em `pdf-writer`, `pdf-forms`, `pdf-draw` e `pdf-fonts`, e a habilidade é reescrita como inspect → create → edit → secure → verify, com o requisito do qpdf (PATH ou `MIXDOG_QPDF_PATH`), a ressalva dos bits de permissão e o limite do texto no lugar declarados.

- A habilidade xlsx e o runtime adotam a disciplina de modelagem que um leitor espera de uma planilha: uma auditoria de fórmulas neutra quanto ao backend (compartilhada por `issues` portátil e pela revisão de qualidade) informa uma referência a planilha de várias palavras sem aspas, um vínculo com pasta de trabalho externa, uma porcentagem guardada como número inteiro, um ano sob separador de milhares e um valor guardado como texto em toda pasta de trabalho (além de, como informação, uma planilha longa cujo cabeçalho não está congelado e uma coluna de tabela de números em Geral), e, sob `auditProfile:'financial-model'`, uma taxa embutida em uma fórmula, uma divisão sem proteção, uma fórmula isolada que quebra o padrão de sua linha ou coluna, uma referência única além da extensão preenchida da planilha (o erro de deslocamento de uma posição que recalcula sem problemas), um valor fixo dentro de uma linha de fórmulas e entradas indistinguíveis de fórmulas, além de uma entrada que uma fórmula lê sem nota de fonte e uma conferência da planilha Checks que avalia como FALSE — em ambos os backends, pois o `issues` do Excel agora incorpora a auditoria compartilhada aos achados do próprio host. Os snapshots expõem o formato numérico, a fonte, a cor e o preenchimento de cada célula estilizada (os inteiros BGR do Excel são normalizados para o mesmo formato RRGGBB), notas legadas por célula e por planilha, tabelas do Excel por planilha (os registros dentro de uma são dados que a tabela origina, então a auditoria só pede nota nas premissas fora dela), intervalos mesclados e painéis congelados no formato do Excel, booleanos como booleanos, o `defaultStyle` da pasta de trabalho e um resumo `document.conventions` (fonte padrão, fontes em uso, formatos numéricos por coluna, marcadores de entrada, exemplos de entradas) para que uma edição possa seguir as convenções do próprio arquivo; `set_formula` coloca entre aspas os nomes de planilha de várias palavras que a pasta de trabalho contém (e, em ambos os backends, qualquer nome de várias palavras escrito antes de `!` e de uma referência) e informa o `normalizedFormula`, o recálculo do LibreOffice retorna um `status` com `totalErrors`, um `errorSummary` por tipo de erro e célula, e as `unparsedFormulas` que o LibreOffice gravou de volta em minúsculas, e `finalize` recusa uma pasta de trabalho cujo recálculo encontrou qualquer erro, mesmo quando a revisão foi ignorada. A habilidade reescreve suas regras em torno de zero erros de fórmula, fórmulas em vez de resultados colados, especificações literais, premissas documentadas, a legenda de preenchimento e a adequação às convenções de um arquivo existente, com `references/model-conventions.md` para cores, formatos numéricos, estrutura, a planilha Checks e fontes.

- A habilidade pptx abre com uma tabela de rotas — uma apresentação nova é um script de `author`, uma apresentação existente é `open` → `snapshot` → `batch`, e a leitura é um `snapshot` paginado ou o extrator de origem — e resolve seus caminhos de script por `${MIXDOG_SKILL_DIR}`, de modo que o QC de páginas, o revisor independente e `source-extract.mjs` (movido para a habilidade, com um teste) rodam de qualquer Projeto. A seção de edição nomeia as armadilhas que o runtime realmente tem: um slide duplicado compartilha sua parte de gráfico com a origem, a decoração do modelo fica onde a contagem de linhas do placeholder a colocou, e um script que declara seu próprio `pres` herda a tela de 10 × 5.625 pol do pptxgenjs. As habilidades docx, xlsx e pdf adicionam os gatilhos que os usuários realmente escrevem ("Word", "Excel", "PDF 읽어", "PDF 만들어"), e a habilidade docx diz como um snapshot mostra uma quebra de linha.

- A edição portátil do PowerPoint resolve o destino de relacionamento de um gráfico como o pacote faz: o pptxgenjs o grava como nome de parte absoluto (`/ppt/charts/chart1.xml`), o que `set_chart_data` e as outras operações de gráfico em uma apresentação criada por author costumavam informar como parte ausente. Os snapshots portáteis agora mantêm quebras de linha e fins de parágrafo como newlines — o texto de formas e notas de uma apresentação, e o texto de parágrafos, células, comentários, revisões, notas e controles de conteúdo de um documento do Word — em vez de juntar "4주차" e "잔존율".

- As faixas de abas dos painéis animam adições e fechamentos no mesmo ritmo das animações da interface: uma nova aba cresce a partir do nada enquanto as vizinhas encolhem, de modo que a sequência nunca transborda a faixa e volta deslizando, e uma aba fechada colapsa no lugar enquanto as sobreviventes deslizam para o espaço dela, em vez de saltar. Um rascunho promovido à sua sessão ainda troca instantaneamente, e a faixa abandona seu estado não usado de retenção de largura.

- A criação de Office ganha três estruturas de qualidade de saída: `author` e `batch` retornam uma `audit` medida (ajuste, limites, contraste, espaçamento, pacote) com contagens por slide e uma ordem de correção no mesmo turno que conta suas rodadas; `author` se recusa a entregar uma apresentação cujos números não têm fato por trás (`facts_gate`), a menos que o briefing declare `facts: sample`, o que leva uma divulgação de números ilustrativos por qa e finalize; e a habilidade pptx traz `scripts/qc-pages.mjs`, um corretor por página que roda uma sessão nova por slide apenas com a ferramenta office e só adota sua cópia de trabalho quando os defeitos medidos da página não cresceram e nenhum outro slide mudou.

- As habilidades dividem sua linha de listagem em uma descrição de uma frase e um gatilho `when_to_use`; a lista de habilidades do modelo mostra `description — trigger` cortado em 250 caracteres, o editor de habilidades ganha um campo Acionador separado, o validador do skill-creator avisa quando uma linha de listagem será cortada, e toda habilidade integrada foi reescrita no novo formato.

- A ilha de Objetivo da sessão alinha sua lista de tarefas com o cabeçalho recolhido, separa as linhas com linhas finas e recolhe ao clicar fora ou com Escape.

- A interface do celular segue a do desktop: o medidor de contexto fica ao lado do gatilho de modelo do campo de redação, as marcas da barra de ferramentas compartilham a família lucide, e a folha da direita abre como uma única unidade de dock cujo cabeçalho traz as mesmas alternâncias de vista da faixa do desktop.

- As habilidades integradas são distribuídas a partir de uma fonte de habilidades empacotada, e os guias do Office viram as habilidades pptx, docx, xlsx e pdf, condicionadas ao recurso que conduzem. As Configurações agrupam habilidades, servidores MCP e hooks dependentes sob seu plugin ou recurso integrado.

- O Office cria apresentações PPTX a partir de scripts pptxgenjs com um guia de design, kit auxiliar, menu de layouts e QC visual conduzido pelo modelo, e tolera diferenças na ordem dos filhos de apresentações e gráficos.

- As chamadas de ferramentas convertem argumentos em texto JSON para o formato declarado no esquema, inclusive esquemas de registro internos.

- O Browser Use separa a política de URL, aba, partição, ocultação de dados e script de snapshot em módulos dedicados; o Computer Use refina o modelo de overlay, o backend de entrada e a coordenação de sessões.

- O aquecimento de inicialização do desktop, a restauração do dock lateral, o momento da redefinição de uso, os arquivos de descoberta de propriedade da bridge e a recuperação do transporte de sessões mantêm as partidas a frio e as reconexões responsivas. Os deploys FastDirect pré-aquecem o runtime instalado.

- O executor de testes separa as faixas rápida, lenta e live com relatórios de tempo; os armazenamentos de sessões fazem cache de resumos de transcrições e varreduras de listagem; os utilitários de requisição de provedores reforçam o tratamento de protocolo do Anthropic, Cursor e OpenCode.

## v0.9.160 - 2026-09-02

- O TUI agora instala seu runtime Ink com patch a partir de um recurso de release versionado. Builds de produção, harnesses de quadros e sondas de carga resolvem o pacote instalado, preservando o comportamento personalizado de cursor, seleção e renderização.

- A inicialização do desktop agora revela shells de painéis utilizáveis antes de a hidratação mais lenta do catálogo e do runtime terminar. As superfícies de Browser, Terminal, Editor e dock lateral são restauradas de forma independente, com sondas de prontidão focadas e serviços do host adiados mantendo as partidas a frio responsivas.

- O Browser Use e o Computer Use agora têm módulos de host baseados em papéis, em vez de monólitos planos. As ações do browser compartilham roteamento explícito, ciclo de vida do guest e contratos de resposta, com tratamento mais robusto de seletores de arquivo e diálogos, enquanto o Computer Use separa as responsabilidades de descoberta, observação, entrada, sessão, overlay e backend, com cobertura de segurança ampliada.

- Os módulos de runtime do Office são organizados por papéis de core, design, qualidade, portátil, PDF, COM e benchmark. Composição livre, seleção de layout guiada por referências, cenas de PowerPoint criadas por author e verificações renderizadas de garantia melhoram a qualidade visual sem enfraquecer a saída editável nem os limites de transação.

- As sessões OAuth da Anthropic agora aprendem uma versão mínima do CLI exigida pelo provedor, persistem apenas atualizações seguras para versões superiores e repetem uma vez a requisição rejeitada sem substituir a configuração explícita de versão.

## v0.9.159 - 2026-09-01

- A aceitação de release do Windows agora verifica o inventário canônico de 16 itens das configurações em vez da contagem obsoleta anterior à navegação.

- O Computer Use agora coordena concessões de alvo em primeiro plano, recaptura após transições de janela, valida sequências limitadas de ações e expõe um overlay de tomada de controle pelo usuário. Os caminhos de captura, teclado, seleção de alvo e recuperação foram divididos em módulos focados, com cobertura mais ampla de host e bridge.

- O Browser Use ganha registros com escopo de sessão e superfícies persistentes por conversa. As vistas de browser, diff e utilitários podem permanecer anexadas ao dock lateral de cada conversa, enquanto as leituras locais de arquivos substituem o caminho duplicado e aposentado do explorador de pastas.

- A compactação de contexto novo agora carrega um handoff limitado da Memória, preserva a continuação do turno ativo e o estado do envelope de ferramentas, e mantém estáveis os layouts de cache do provedor durante a compactação. A ingestão da Memória projeta a transcrição compactada de forma consistente, em vez de depender do caminho fast-track aposentado.

- A geração de apresentações do Office adiciona direção criativa, gramática de layout, fluxo visual semântico, revisão estética renderizada e uma pontuação de qualidade de release, de modo que a saída das apresentações é mais variada e detecta composições fracas mais cedo.

- O churn de verificação e de infraestrutura de release cai bastante: o monólito de 3,500 linhas de tool-smoke agora virou catorze suítes `node --test` focadas em `scripts/tool-contracts/`, com asserções frágeis de redação exata relaxadas para contratos de frases-chave, a seleção de caminhos do CI tem fonte única em `scripts/release-paths.mjs` tanto para o portão de release quanto para o planejamento de deploy, e uma release deixa de reexecutar a faixa crítica quando o portão já verificou exatamente os mesmos commits.

- Nenhuma suíte pode mais apodrecer em silêncio: os monólitos de teste restantes (provider-toolcall, session-transport, shell-hardening) são suítes por domínio em `scripts/`, o portão de release agora executa os contratos de tool-contract e de compactação (recall-fasttrack) em todo push com portão, e uma varredura semanal `suite-health` executa todo script `test:*`/`smoke:*` registrado por meio de um catálogo de exclusão voluntária, abrindo uma issue rastreada em caso de falha.

## v0.9.158 - 2026-08-31

- O hub de Extensões agora oferece a Git, Memória, Browser Use, Computer Use, Office e voz um fluxo consistente de instalação, progresso, ativação e desativação. Os runtimes opcionais são preparados sob demanda, o Office pode instalar o LibreOffice pelo gerenciador de pacotes da plataforma, e desativar a voz preserva os recursos baixados.
- O empacotamento do runtime do desktop é menor e mais determinístico: as cargas de recursos opcionais ficam fora do app base, o código de runtime é preparado uma vez, os deploys por snapshot toleram edições simultâneas, e o CI de release compartilha um build de runtime multiplataforma com portões explícitos de Git e Computer Use.
- O Studio preserva rascunhos por item e torna a edição de detalhes, a seleção e as interações de teclado resilientes à navegação. Os controles de uso de contexto e de ditado por voz também informam seu estado atual de forma mais consistente.
- A rota OAuth da OpenAI deixa o pré-aquecimento de prompts por WebSocket desativado por padrão, evitando uma requisição de aquecimento desnecessária, a menos que seja explicitamente ativado.
- O Terminal-Bench 2.1 publica a comparação completa `k=5` do Codex CLI com artefatos Harbor brutos, verificação do commit de origem, proveniência de custos recuperados e geração reproduzível de relatórios.

## v0.9.157 - 2026-08-31

- O Browser Use ganha uma divisão de host menor e mais confiável entre abas, downloads, interceptação, permissões, snapshots, relatório de diálogos e ciclo de vida de páginas. A importação de perfil do Chromium agora inclui a descriptografia offline de cookies App-Bound v20 por meio do importador nativo empacotado, sem expor segredos descriptografados ao renderer nem ao agente.
- O Computer Use é decomposto em módulos limitados de captura, descoberta, seleção de alvo, observação, entrada e worker. Propriedade de recursos mais justa, estado pós-ação mais novo, proteções de entrada mais rígidas e cenários de repetição ampliados tornam sessões nativas e Chromium de longa duração mais rápidas e seguras.
- A Memória passa a um runtime compacto de embeddings E5 com preenchimento incremental dos mais recentes primeiro, compressão e retenção de cache, ranqueamento lexical ciente do coreano e recuperação de workers ociosos. O antigo addon nativo de tokens e o caminho de modelo legado mais pesado foram removidos do runtime distribuído.
- A recuperação de sessões promove o diário de checkpoints a limite durável de retomada, preservando uso do provedor, âncoras de compactação, handoff de recall e replay de thinking da Anthropic entre interrupção, nova tentativa e reinicialização, sem duplicar contexto.
- A criação de Office adiciona planos de composição elaborados pelo modelo, uma biblioteca de design reutilizável, prévia de documentos e primitivas portáteis mais amplas de Word, Excel e PowerPoint, mantendo as verificações de garantia estruturais e renderizadas.
- As superfícies web de desktop e celular ganham Browser Use remoto, recebimento de compartilhamento, notificações push, edição e prévia de documentos mais ricas, restauração de inicialização mais silenciosa e atualizações de cache do service worker mais previsíveis.
- A busca nativa agora limita as concessões de inventário amplo e admite de forma justa trabalhos concorrentes de find, glob e grep. A automação de release reconstrói incrementalmente os recursos nativos e de voz alterados, verifica os sidecars empacotados e reutiliza os artefatos de runtime de plataforma inalterados.

## v0.9.156 - 2026-08-29

- A criação portátil de Office ganha renderização de gráficos e métricas de texto, de modo que mais trabalhos de PPTX e XLSX terminam sem passar ao host Office COM.
- Os contratos das ferramentas Browser Use e Computer Use são revisados junto com o armazenamento de configurações do desktop, a validação de IPC e a formatação de ferramentas na transcrição.
- A rolagem virtual do desktop agora acompanha os pacotes upstream, e a fixação da transcrição no fundo depende do adiamento de rolagem do próprio core.
- Os deploys de desenvolvimento podem rodar a partir de um snapshot congelado da árvore de trabalho (`update:dev:snapshot`), o que permite que uma instalação tenha sucesso enquanto outras sessões continuam editando o repositório, em vez de falhar na verificação da impressão digital de entrada.

## v0.9.155 - 2026-08-29

- A importação de slides PPTX, a substituição de imagens e a criação de dados de tabelas agora rodam no mecanismo portátil, de modo que essas operações não exigem mais o host Office COM.
- A criação de Office ganha módulos portáteis de empacotamento, composição, estilo de planilha e formas de slides por trás do pipeline existente de garantia e qualidade.
- O acompanhamento de Goal ganha tratamento de lembretes e de extração de texto para continuações, e o desktop mantém os metadados de sessão em sincronia com um orçamento limitado de cache do renderer para o estado de sessões não lidas.

## v0.9.154 - 2026-08-29

- As sessões do Computer Use são recuperadas em todos os caminhos de saída, em vez de depender de um temporizador unref'd que um runtime em saída nunca dispara: o encerramento do daemon e dos workers as libera, uma sessão que fecha libera a sua, os workers ociosos do host expiram no mesmo relógio das reservas de janela que mantêm, e uma conexão de cliente interrompida aborta a entrada em andamento em vez de deixá-la comandar a área de trabalho até o timeout do comando. O cliente também tenta uma vez de novo contra uma bridge republicada, de modo que reiniciar o app desktop não faz mais o próximo comando falhar de imediato.
- Uma página do Browser Use que travou se recupera no próximo comando em vez de fazê-lo falhar. As refs vinculadas ao documento morto são descartadas com ele, de modo que a recuperação nunca pode devolver coordenadas de uma página que não existe mais.
- A compactação que roda entre um prompt e a requisição ao provedor não trava mais quando o runtime de memória emperra: a chamada de memória recall-fasttrack é limitada para todo chamador, e não apenas para o único caminho que por acaso tinha um timeout.
- O analisador de entradas ocultas do Windows Explorer divide a saída do attrib.exe com as regras de caminho do Windows em qualquer host, e a sonda de capacidade do hook de commit agora funciona em versões do git que discordam sobre se o nome de um hook não nativo precisa de uma flag.
- O Deploy deixa de reconstruir runtimes de plataforma idênticos byte a byte. As fontes de teste saem tanto do pacote publicado quanto da chave de cache do runtime, de modo que uma mudança apenas em testes acerta o cache de runtime preparado em vez de pagar uma reconstrução de sete minutos no Windows. As suítes do desktop rodam como jobs paralelos do portão, inclusive uma etapa Windows que finalmente exercita o Computer Use no CI, e a suíte de git de 240 segundos não fica mais na execução local padrão.

## v0.9.153 - 2026-08-28

- O Computer Use no Windows agora executa um laço de observação menor no estilo CUA: acessibilidade compacta e uma captura de tela simples são retornadas juntas por padrão, o estado pós-ação é atualizado imediatamente, o AX e o OCR de fallback compartilham um único orçamento rígido de elementos, capturas inutilizáveis pretas, brancas ou incompatíveis nunca emitem um quadro de coordenadas, as mutações invalidam quadros de pixels anteriores, um novo pop-up do mesmo processo se torna o alvo determinístico de verificação, campos de texto do Electron pertencentes ao app usam inserção em segundo plano nativa do renderer, a recuperação indica o próximo degrau de escalonamento, e teclas perigosas que encerram a sessão, cargas de shell ou inicializações de shell/hosts de script são bloqueadas na fronteira do host. Um painel Windows de 23 cenários agora cobre caminhos nativos, Electron, Chrome, OCR coreano, segundo monitor, estado obsoleto, foco, pop-up, segurança e limpeza.
- As observações e turnos do Computer Use ficam mais rápidos sem enfraquecer a fronteira de entrada: snapshots leves de transição/quadro do Win32, captura exata da janela, acessibilidade limitada do Chromium moderno, polling adaptativo de inicialização, proteções de recursos de captura e recuperação verificada de foco/cursor substituem a enumeração completa e repetida de apps e os fallbacks ilimitados. A digitação literal direcionada a um elemento pode focar e digitar em uma só ação, e o OCR limitado pode ser incluído na captura obrigatória pós-ação. A matriz final de 23 cenários × 10 hosts de origem atingiu 230/230 aprovações semânticas e reduziu a latência p50/p95 de cenário da linha de base em 90.55%/94.01%; uma matriz separada de estresse denso/minimizado/alvo obsoleto passou em 40/40. Todas as 30 recapturas pós-ação redundantes foram removidas, e as chamadas caíram 36.84% nos cinco fluxos de ação agrupáveis. O agrupamento arbitrário de mutações continua sem suporte.
- O Computer Use agora expõe um único contrato rígido de 15 ações em vez de 28 ações sobrepostas ou de um esquema plano de campos opcionais. Observação/busca/zoom usam `capture`, o ciclo de vida de janelas e da área de transferência usa campos de operação, e um único objeto `capture_after` compartilhado configura a verificação automática. A orientação alinhada à referência exige alvos exatos e novos, prefere elementos semânticos e mantém o Browser Use separado. O esquema final tinha 2,644 tokens estimados antes das extensões de fronteira; o contrato de fronteira anterior à remoção passou em 36/36 cenários de primeira chamada do modelo. O contrato atual de despacho direto tem 3,210 tokens estimados e 14,485 bytes de rede. O `diagnose` somente leitura informa a prontidão de OCR/UIA do Windows sem pixels de tela; o `sequence` limitado para em caso de falha ou transição de alvo e retorna um único estado final novo; a cardinalidade estrita de chamadas impede mutações paralelas entre alvos, tanto na orientação ao modelo quanto antes do despacho antecipado do runtime. Chamadas `computer` extras no mesmo turno não são executadas e recebem um erro de recuperação de estado novo. A seleção em linguagem natural passou em 4/4 cadeias seguras de foco e 4/4 fronteiras de transição. Em 10 repetições, uma continuação de duas ações usou 50% menos chamadas e capturas voltadas ao modelo, com latência p50/p95 reduzida em 12.34%/32.31%. Os pedidos de confirmação do Computer Use e de aprovação de transações do Office voltados ao modelo foram removidos; ações solicitadas pelo usuário agora são executadas diretamente, enquanto padrões bloqueados de tecla, carga e host de script continuam sendo erros definitivos. O uso medido do provedor é de 5,150 tokens de entrada e 4,026 ms de p50 por chamada do modelo. Um esquema pós-observação de 12 ações reduziu a entrada em 18.16% com 27/27 de acerto, mas foi rejeitado porque outliers repetidos de latência e mudanças de esquema no meio do laço quebrariam o contrato imutável do cache de prefixo do provedor. Ações semânticas com transições determinísticas de janela exata agora informam verificação confirmada. Nenhum fallback de formato de chamada legado permanece. Após um deploy de desenvolvimento, a validação no app instalado confirmou que `click(ref)` esquerdo usa ativação semântica e que a inicialização por associação nativa de arquivo retorna seu alvo selecionado com estado novo; marcas e coordenadas continuam sendo operações explícitas de ponteiro.
- O Browser Use pode importar senhas, cookies e histórico do Chromium, sugerir apenas contas mascaradas para a origem HTTPS atual e preencher um formulário de login selecionado dentro de um mundo CDP isolado, sem expor a senha armazenada ao renderer, ao agente, aos diagnósticos nem aos logs. Os Utilitários agora usam por padrão a primeira aba do lado direito, migram a antiga posição padrão sem redefinir layouts personalizados e incluem o ponto de entrada do Browser.
- O FastDirect agora calcula a impressão digital, prepara, faz backup e restaura atomicamente os sidecars nativos de importação do navegador junto com `runtime.asar`, de modo que atualizações incrementais de desenvolvimento não podem deixar o app instalado sem seu importador.
- O uso de contexto da sessão agora registra um snapshot canônico pós-compactação que sobrevive à persistência e à reinicialização até o próximo turno o invalidar. O estado do Goal e a recuperação da compactação permanecem consistentes entre serviços reiniciados, em vez de repintar um uso de tokens obsoleto ou perder trabalho retomável.
- A geração de Office agora compartilha um modelo de conteúdo semântico, verificações de garantia estruturais e renderizadas, revisão de injeção de prompt, portões de checklist e um pipeline de acabamento em Word, Excel e PowerPoint. Os controles de página/vista de planilhas, a seleção por capacidade de modelo, a persistência de dados de gráficos nativos e a verificação ao vivo de salvar e reabrir reforçam documentos com qualidade de release.

## v0.9.152 - 2026-08-27

- O modo Goal agora pode levar um objetivo de longa duração por vários turnos, com condições de conclusão duráveis, controles de pausar e retomar, limites de tempo, continuação automática, ferramentas de gerenciamento voltadas ao modelo e uma ilha de status do Desktop com escopo de sessão.
- O Browser Use e o Computer Use do Windows estão disponíveis como recursos integrados opcionais. O Browser Use pode inspecionar e operar páginas no app ou em segundo plano, enquanto o Computer Use combina UI Automation, capturas de tela, teclado, ponteiro, rolagem e ações de janela, com entrada ciente de DPI e proteções de segurança.
- A recuperação de provedores agora preserva a ordem original de raciocínio, texto e chamadas de ferramentas em streams da Anthropic, Gemini, OpenAI e compatíveis, inclusive em novas tentativas, turnos travados, sessões salvas, projeção remota e compactação.
- A compactação inicia uma nova época do cache de leitura depois de alterar a transcrição, e as sessões existentes sincronizam as ferramentas de runtime recém-disponíveis nos limites de turno, em vez de manter um catálogo de ferramentas obsoleto.
- A navegação no desktop e no celular está mais limpa e previsível: as reaberturas no celular começam com uma única Nova tarefa, enquanto as reconexões mantêm os painéis atuais, os gestos de deslizar entre painéis funcionam em conteúdo rico e sobreposições, e páginas laterais, extensões, Markdown, rótulos de status e ações finais compartilham layouts responsivos mais compactos.

## v0.9.151 - 2026-08-26

- Editar um link simbólico agora altera o arquivo para o qual ele aponta, em vez de ser recusado: patch e edit seguem o link em todos os mecanismos, gravam atomicamente ao lado do destino real e deixam o próprio link intacto.
- As execuções headless e de benchmark não deixam mais bancos de dados e processos temporários para trás. Cada execução recebe uma raiz de runtime isolada, o encerramento espera o daemon de sessões em vez de informar sucesso antes dele, e clusters órfãos são varridos na saída.
- A compactação da conversa mantém tudo o que deveria. A compactação automática, manual e limpa compartilham um caminho, o resumo armazenado vem à frente com o histórico bruto completo atrás, e os turnos mais recentes sobrevivem literalmente em vez de serem aparados por um limite de linhas ou tamanho.
- A exploração lê o arquivo original antes de decidir como analisá-lo, contá-lo ou resumi-lo, de modo que um palpite de formato não conduz mais a resposta.
- Acabamento do desktop: imagens anexadas abrem no visualizador do sistema, as linhas de cota do painel de uso aparecem em uma ordem natural, e os painéis de contexto e de rota perdem as molduras e os contornos de foco que sobravam.
- Os resultados do Terminal-Bench 2.1 são republicados a partir de uma execução `k=5` das 89 tarefas, com os artefatos brutos de verificação de cada execução publicada incluídos no commit junto com os scripts do harness e das métricas.

## v0.9.150 - 2026-08-25

- Os resultados das ferramentas continuam fáceis de percorrer e honestos quanto ao tamanho: a saída de buscas e as leituras de vários arquivos respeitam um orçamento fixo em vez de inundar uma resposta com milhares de linhas, e um caminho que simplesmente não existe — ou um veredito comum sobre o estado do repositório — volta como a resposta, e não como uma falha que leva o assistente à recuperação.
- As sessões não carregam mais uma impressão digital obsoleta do provedor após uma reinicialização, e uma nova mensagem acorda imediatamente um turno que espera uma tarefa em segundo plano, de modo que a resposta chega em vez de ficar atrás da espera.
- A seleção de texto no terminal se recupera de um arraste cujo botão foi solto fora da janela, e uma seleção arrastada além da borda superior ou inferior segue o comportamento normal de início e fim de linha, em vez de congelar na última coluna que o ponteiro ocupava.
- O ditado por voz pede confirmação antes de instalar seu runtime, os cartões de ferramentas e os quadros de diff se alinham ao tema compartilhado, e dez idiomas da interface foram atualizados.

## v0.9.149 - 2026-08-24

- As sessões OAuth da OpenAI agora falam por padrão o formato de protocolo do cliente de referência: identidade estável de instalação e de thread, a forma mais leve de requisição nos modelos atuais e tratamento correto, pelo provedor, de um socket que atinge o limite de vida no meio da sessão.
- A inicialização da sessão reserva sua conexão pré-aquecida para o primeiro turno apenas quando o prompt que ela aqueceu ainda corresponde, de modo que um turno cujo ambiente ou superfície de ferramentas mudou começa limpo em vez de reenviar a requisição inteira.
- As listagens de diretório retornam uma primeira página dimensionada para varredura em vez de um despejo, e as consultas à estrutura de código buscam corpos completos de símbolos apenas quando a implementação exata é necessária.

## v0.9.148 - 2026-08-24

- As conversas no desktop e no celular preservam rascunhos, histórico, comportamento de acompanhamento, gestos de painéis e estado remoto de forma mais confiável, reduzindo a transferência pelo relay e a sobrecarga de implantação do renderer.
- As sessões de agentes recuperam streams de provedores, compactação, estado de workers e resultados de ferramentas de forma mais consistente, com desfechos mais claros de conflitos do Git e de ambiente e telemetria de busca mais precisa.
- A entrada de voz ganha um caminho de release de runtime multiplataforma verificado, enquanto a recuperação de memória, o tratamento de processos nativos e a preparação do runtime empacotado foram reforçados.
- A automação de releases, o deploy FastDirect e os relatórios de benchmark agora reutilizam artefatos inalterados e comparam chamadas de modelo, custo e contexto final com contabilidade correta por provedor.

## v0.9.147 - 2026-08-21

- As sessões longas da OpenAI agora mantêm intactos a cadeia de respostas e o pin de estado do turno entre reconexões, reordenação de itens e compactação, de modo que o cache de prefixo do provedor sobrevive a uma sessão em vez de reiniciar no meio da tarefa.
- A inicialização da sessão pré-aquece o prefixo do provedor e separa os detalhes do ambiente do prefixo de instruções compartilhado, reduzindo partidas a frio e o upload repetido de contexto idêntico.
- As regras de uso de ferramentas ficaram mais curtas com as mesmas garantias: as cláusulas de roteamento agora desaparecem junto com as ferramentas que citam, e os resultados do shell são classificados pelo runner que os produziu.
- Os cartões de ferramentas e os resumos de resultados do desktop foram localizados, e o medidor de contexto informa a estimativa pós-compactação em vez do prefixo descartado.
- As execuções de benchmark ganham predefinições de rotas rápidas e um adaptador de referência do grok CLI, de modo que os números de referência vêm dos mesmos contêineres e do mesmo verificador.

## v0.9.146 - 2026-08-21

- As conversas web no celular agora mantêm estáveis a rolagem por toque, a medição de Markdown em streaming, os gestos de aba, os controles compactos do campo de redação e as sobreposições responsivas, entre gestos nativos, rotação e layouts de tela pequena.
- As sessões podem levar uma conversa inteira para o modelo atualmente selecionado quando ela cabe no limite de contexto desse modelo, enquanto o uso de contexto e os detalhes da rota herdada continuam explícitos.
- Os grupos de ferramentas da transcrição preservam suas chamadas, argumentos, saídas e estado de conclusão originais para inspeção detalhada, com prévias de imagem localizadas e uma apresentação de atividade mais clara.

## v0.9.145 - 2026-08-21

- As sessões web no celular agora mantêm estáveis a escala nativa da viewport, a recuperação de pareamento, a projeção de estado remoto e a rolagem da transcrição, entre gestos de toque, medições de linhas em streaming, restaurações do app e conexões lentas.
- Os painéis do desktop, as atualizações do controle de código-fonte, a atividade de ferramentas, as superfícies de comandos e o estado das sessões se recuperam de forma mais consistente, preservando layouts responsivos e um retorno mais claro de carregamento ou interrupção.
- O roteamento de ferramentas do agente agora aplica proteções de argumentos mais rígidas, política de mutação do Git, tratamento de prefixo do provedor, projeção de evidências e recuperação de saída do shell no runtime compartilhado e no TUI.
- As ferramentas de release, benchmark, localização e diagnóstico agora validam seus contratos com cobertura de regressão mais ampla e relatórios de runtime mais compactos.

## v0.9.144 - 2026-08-21

- A interação no desktop agora acompanha com mais confiabilidade o foco do teclado e do ponteiro, melhora os gestos de deslizar entre painéis no celular e a apresentação de transcrição/status, e informa o estado de tarefas de shell em segundo plano com uma recuperação mais segura.
- Os painéis de diff do Git revelam imediatamente o próprio estado de carregamento, combinam atualizações sobrepostas e renderizam o texto do repositório sem invocar comandos externos de diff ou textconv configurados.
- O Solo agora é o workflow padrão, as regras de uso de ferramentas preservam evidências enquanto agrupam o trabalho de forma mais rigorosa, e janelas limitadas de read/grep reduzem o contexto desnecessário sem esconder a paginação.

## v0.9.143 - 2026-08-20

- A execução de sessões agora compartilha um único worker de runtime supervisionado, em vez de um pool de shards de processos. Os agentes em segundo plano permanecem no mesmo processo, as esperas por provedores cedem seu espaço de admissão local de CPU, e os limites de spawn em toda a máquina e a recuperação da saúde do runtime continuam sendo aplicados.
- As aprovações de dispositivos remotos aparecem apenas enquanto Configurações → Conexão está aberta, recuperam as requisições pendentes quando esse painel abre e só terminam depois que o navegador comprova sua conexão E2EE autenticada.

## v0.9.142 - 2026-08-20

- O empacotamento do desktop para Linux valida a arquitetura de destino no diretório de prebuild da ABI que o `node-pty` realmente carrega, enquanto os pacotes compilados para Windows e macOS mantêm seu caminho de validação `build/Release`.

- Os apps web instalados retomam uma aprovação pendente do desktop entre recarregamentos, enquanto o desktop substitui prompts obsoletos, os expira junto com a requisição do relay e aceita cada decisão apenas depois que o serviço a confirma.
- O FastDirect reutiliza alvos de build novos, um cache persistente do renderer de produção, a saída de runtime preparada e um template de shell ASAR extraído. Os deploys live do relay calculam independentemente a impressão digital das mudanças de renderer/servidor e enviam apenas deltas verificados do renderer antes da troca atômica na VPS.
- O código inline segue a fonte e o tamanho da prosa ao redor, deixando a cor como sua única distinção inline, enquanto o código em bloco continua monoespaçado.

## v0.9.141 - 2026-08-20

- A criação de tarefas no desktop funciona no Electron 41 e no Node 24: o roteador de shards de agentes agora copia os exports ESM imutáveis do gerenciador de sessões para uma fachada gravável antes de instalar suas substituições de sessão remota.

## v0.9.140 - 2026-08-20

- As exclusões no Studio têm efeito no primeiro clique: uma execução concluída libera seu espaço na grade assim que seu recurso é indexado, de modo que excluir esse recurso não reanima mais o espaço como um bloco fantasma "generating". A galeria não é mais limitada a 2,000 entradas — um recurso só sai do armazenamento por uma exclusão explícita — e uma execução que falha, começa sem uma tarefa ou perde seu snapshot de runtime agora informa isso, em vez de girar em silêncio.
- O alternador de abas no celular aparece como uma grade de cartões e só ganha um campo de filtro quando a lista é longa o bastante para precisar de um, enquanto o chrome do celular refaz os discos do campo de redação, a ilha de status e as folhas de painéis em proporções de toque, e traz ao alcance os controles que só apareciam ao passar o cursor.
- Um app web instalado pode se parear sozinho: ele abre uma URL de entrada roteada por dispositivo, pede aprovação a esse desktop por trás de um código de dois dígitos mostrado nas duas telas e recebe o material de pareamento selado para sua própria chave descartável. Os navegadores pareados agora registram quais faixas de push eles leem, de modo que um celular conectado não paga mais por tráfego de terminal, editor e arquivos que nunca mostra.
- O servidor de busca do code-graph atende clientes de pipe compartilhado com filas de resposta por conexão e ids de requisição com escopo de cliente, e encerra sozinho após uma janela de inatividade, de modo que um dono morto à força deixa de abandonar servidores aquecidos.
- As chamadas de ferramentas sobrevivem ao ruído nos argumentos do provedor: um caminho base opcional omitido é resolvido para o Projeto atual em vez de falhar a chamada, os argumentos de task são restringidos à ação escolhida, e a saída do git mantém seu último quadro de progresso e sua linha fatal final, em vez de enterrar o motivo sob quadros de redesenho.
- O renderer carrega um único catálogo de idioma da interface em vez de onze, define o idioma antes de o primeiro módulo do app ser avaliado e pré-busca um chunk de superfície ao selecionar; /inherit leva uma conversa existente para uma nova sessão na rota atualmente selecionada.
- O crédito a terceiros é carregado apenas por LICENSES e NOTICE.

## v0.9.139 - 2026-08-20

- O OAuth do Antigravity chega como provedor: um único login do Google expõe o Gemini 3.x e o Claude pelo gateway Cloud Code Assist, com login, renovação de token e failover de endpoint seguindo o formato existente dos provedores OAuth.
- Os agentes agora têm exatamente dois estados, um modelo fixado ou desligado, e a Web Search resolve o Modelo Principal quando sua rota é deixada sem definição.
- Os navegadores pareados alcançam a superfície de operações do desktop — instruções do projeto, navegação e locais de pastas, e o contrato do git — por meio de um módulo único e compartilhado de validação de argumentos, enquanto o estado de sessão do relay viaja como deltas compactos com escopo de cliente dentro de quadros binários E2EE.
- O app web agora distribui assets brotli e gzip pré-comprimidos, retém aquecimentos de segundo plano e fontes em conexões limitadas ou lentas, redimensiona anexos de imagem e áudio de ditado antes do upload, abandona o desfoque ao vivo da ilha de status fixada em celulares e pinta o destaque da marca em azul do Google.
- A preparação do runtime do Windows e o empacotamento asar sobrevivem a scripts de ciclo de vida do repositório e a bloqueios transitórios de arquivos pelo antivírus, e a linha de status do TUI calcula diretamente, no caminho instantâneo, a contagem de shells em execução.

## v0.9.138 - 2026-08-19

- As sessões web remotas agora usam assinaturas com escopo de cliente, quadros binários E2EE, deltas compactos de estado/catálogo, agrupamento do terminal e sondas de latência de pintura, reduzindo o volume transferido e preservando a recuperação ao vivo em conexões lentas.
- A rolagem da transcrição web e a entrada no campo de redação permanecem visualmente estáveis durante snapshots remotos simultâneos, trocas de sessão e renderização no celular.
- O contexto de runtime, a recuperação de requisições ao provedor, as notificações de tarefas em segundo plano e a restauração de conclusões foram reforçados em sessões de longa duração.

## v0.9.137 - 2026-08-19

- A recuperação de reconexão remota agora atualiza os catálogos de sessões e as faixas de transcrição montadas, e o controle de atualização lidera o grupo de botões da barra de título.

## v0.9.136 - 2026-08-19

- O sistema aposentado de mensagens por Discord/Telegram e a infraestrutura de sessões de canal foram removidos, enquanto as barras de sistema do celular permanecem consistentemente pretas.

## v0.9.135 - 2026-08-18

- O desktop agora preserva layouts de painéis, estado da barra lateral, geometria de painéis e rascunhos do campo de redação entre recarregamentos e reinicializações do FastDirect, com cobertura de regressão ampliada do renderer.
- A execução do shell agora reforça a limpeza do ambiente, o standby aquecido, a recuperação de conclusões em segundo plano, o tratamento de processos nativos e o roteamento de ferramentas em sessões interativas e headless.
- As releases do native spawn para Linux são vinculadas estaticamente, a busca em grafo e os relatórios de recall foram reforçados, e as ferramentas de roteamento e de relatórios do Terminal Bench foram atualizadas.

## v0.9.134 - 2026-08-17

- O desktop agora distribui a marca selecionada, um editor unificado de rotas de modelos com parâmetros de modelo e ordem de lista persistida, e desempacota o node-pty ao lado do daemon empacotado.
- A compactação de sessão é travada por dono: as sessões de agentes permanecem semânticas, as sessões de usuários usam recall-fasttrack. As Configurações não listam mais as memórias Core (elas vivem no projeto), e o inventário de aceitação do Windows foi ajustado.

- As integrações de provedores e ferramentas agora incluem ciclo de vida OAuth e recuperação de tokens na Anthropic, Cursor, Grok e OpenAI, normalização de esquemas de ferramentas específica do Grok e a decomposição do fan-out de caminho/padrão de search e grep.
- A orquestração de sessões e os fluxos do TUI agora impõem escopo por sessão dona, preservam cartões de handoff concluído e de conclusão em segundo plano entre restaurações, retêm prompts enfileirados externalizados e classificam desfechos entre falhas de comando, erros de ferramentas e ausências benignas.
- A navegação do workspace no desktop agora preserva os títulos de sessões dos painéis durante interações de arrastar, adiciona novas tentativas de restauração do workspace na partida a frio que impedem abas perdidas, e atualiza os painéis de onboarding e de configuração de capacidades.

## v0.9.133 - 2026-08-16

- A projeção de evidências somente do provedor agora cria aliases de caminhos de arquivos tipados repetidos dentro de épocas de mutação, preservando envelopes exatos de ferramentas e caminhos reconstruíveis, enquanto reduz o contexto cumulativo em sessões longas.
- A execução do Git agora compartilha uma política de mutação entre a orquestração e a projeção de evidências, serializa gravações em todo o repositório contra edições de arquivos, usa processos nativos pertencentes à árvore e torna abortáveis os bloqueios enfileirados.

## v0.9.132 - 2026-08-16

- A execução de ferramentas agora expõe o status de saída completo do shell, adiciona uma superfície dedicada do Git, reforça a criação atômica de patches e os diagnósticos, e melhora a integridade de busca, listagem, code-graph e do grafo nativo sob carga concorrente.
- A compactação de sessões, a recuperação de provedores/imagens, o rastreamento de evidências, a saúde dos shards e a limpeza do runtime do Lead agora preservam o estado em falhas sem mascarar workers degradados nem disparar trabalho de fallback desnecessário.
- O roteamento do desktop, a atividade de agentes, o estado restaurado dos painéis e a renderização de Markdown em streaming agora permanecem responsivos e visualmente consistentes em conversas ao vivo e retomadas.

## v0.9.131 - 2026-08-14

- Os portões de release agora rodam automaticamente com seleção incremental de caminhos, os runtimes de plataforma do desktop são preparados antes do empacotamento, os builds do grafo nativo usam um perfil reproduzível mais rápido, e o deploy de produção web/relay inclui rollback atômico e verificação de hash e de saúde.
- As faixas de release do desktop agora empacotam assim que seu runtime correspondente está pronto, os caches do compilador do grafo permanecem isolados entre builds de reprodutibilidade, as instalações do relay são fixadas por lockfile, e o tempo de release avisa sobre regressões de 10%.
- A limpeza de agentes não confunde mais projeções do pool do Lead com workers filhos, de modo que descartar outro runtime não pode fechar a conversa ativa do desktop nem descartar uma mensagem de acompanhamento aceita.

## v0.9.130 - 2026-08-14

- A recuperação de provedores e sessões agora classifica de forma consistente as falhas transitórias de stream, repete os turnos rejeitados por causa de imagem sem perder a intenção do usuário e preserva o estado de interrupção, de resumo e de desfecho final entre os transportes do Gemini e da OpenAI.
- As falhas de ferramentas são persistidas sem poluição de rastros de teste, a política de shell evita falsos positivos em scripts entre aspas, e os caminhos nativos de busca/leitura/listagem/stat compartilham trabalho cancelável, preservando a invalidação atualizada do watcher e o comportamento exato de grep/glob de arquivos sob carga.
- O Studio do desktop, o uso, a atividade de agentes, o layout de painéis, a localização e a apresentação das etiquetas de workers agora permanecem alinhados entre sessões restauradas e ativas.

## v0.9.129 - 2026-08-14

- O exec headless agora roda por padrão uma superfície solo de verdade: as ferramentas de busca na web e de memória ficam desativadas, a menos que --web-search / --memory as reativem, os processos filhos do shell herdam um proxy imposto sem saída para a rede (o loopback continua acessível), e a linha de ambiente da sessão declara network=offline, de modo que os modelos nunca tentam acessar a web.

## v0.9.128 - 2026-08-14

- As ferramentas de exploração agora terminam na rodada de busca: o grep gasta seu orçamento de saída em blocos de código ranqueados (correspondências de ramos raros primeiro), o find descarta resultados difusos apenas de ruído, e os outlines de símbolos do code_graph filtram antes de limitar e respeitam pedidos de corpo.
- A orientação aos agentes agrupa uma chamada bem roteada por incógnita, em vez de um fanout especulativo de várias ferramentas, reduzindo o uso de tokens do benchmark em um terço sem mudar a taxa de aprovação.
- Reforço da recuperação de sessões e da resiliência do runtime na busca nativa, no contrato do shell e nas ferramentas de leitura/listagem.

## v0.9.127 - 2026-08-14

- Os binários nativos agora têm um único lar canônico nas Releases do GitHub: o npm distribui apenas o CLI, enquanto as execuções do CLI verificam e armazenam em cache os recursos sob demanda, e os builds do Desktop incorporam os mesmos recursos de plataforma verificados.

## v0.9.126 - 2026-08-14

- A busca nativa agora trata o contrato interno completo de grep/find, preserva os erros de recuperação de regex e sobrepõe a busca do primeiro turno ao aquecimento do code-graph.

## v0.9.125 - 2026-08-13

- A execução de shell e de tarefas em segundo plano agora usa um único gerenciador de processos nativo com hash fixado no Windows, Linux e macOS, sem fallback de ambiente, build local, registro de arquivos, shell em standby ou processo Node.
- Os caminhos nativos de busca, patch, download, mídia, recall, webhook e sessão agora impõem recursos limitados, propriedade mais rígida e verificações reforçadas de transporte e de cadeia de suprimentos de release.
- A extração do runtime de memória agora aceita links verificados dentro do arquivo, ainda rejeitando travessia de diretórios, links externos e entradas tar especiais.
- O comportamento de projetos, terminal, atualização, pareamento remoto, relay e painéis do desktop agora inclui as correções consolidadas de segurança, recuperação e layout responsivo.

## v0.9.124 - 2026-08-12

- A atividade de agentes do desktop agora agrupa todas as sessões ativas independentemente da aba em foco, enquanto os painéis de sessões restauradas são pré-aquecidos corretamente e as sessões existentes aceitam entrada de acompanhamento sem esperar a confirmação do host.
- O transporte de sessões do desktop e do daemon agora sobrevive a corridas de inicialização, sessões de controle obsoletas, perdas transitórias de socket e recuperação de stream no lugar, mantendo a propriedade remota global entre mudanças de foco de sessão.
- As preferências de commit do Git agora separam o exemplo visível das instruções de IA, serializam gravações sobrepostas e validam e depois corrigem a saída Conventional Commit antes de aceitá-la.
- A memória Core agora espelha o contexto curado e gerado em um arquivo atômico protegido por revisão, de modo que as sessões podem carregar memória com escopo sem iniciar a frio o runtime de memória, com as mutações atualizando o espelho.
- A ancoragem da transcrição do TUI e o tratamento de seleção com Escape evitam saltos visuais e restaurações acidentais da fila, enquanto o fallback de recusa do Terminal-Bench segue o motivo de término do runtime mesmo após uma narração em streaming.

## v0.9.123 - 2026-08-12

- A configuração de provedores no desktop agora recupera sessões de controle obsoletas sem expor falhas brutas de transporte, e o histórico de prompts só é acionado a partir de um rascunho vazio.
- A busca de caminhos evita varreduras completas da árvore a frio, combina pré-aquecimentos do watcher e aperta os prazos da busca nativa, a concorrência em massa e os snapshots de processos.
- A orientação de timeout do shell assíncrono agora distingue trabalho ilimitado em segundo plano de prazos explícitos de encerramento.

## v0.9.122 - 2026-08-11

- As regras de roteamento de ferramentas agora centralizam as convenções de caminho, removem a orientação duplicada de agrupamento e exigem inspeção somente leitura apenas quando as evidências estão em risco.
- O preflight de benchmark da Anthropic agora resolve corretamente os imports de provedores a partir de snapshots temporários isolados do harness.

## v0.9.121 - 2026-08-11

- As regras de execução de ferramentas e os diagnósticos do shell agora distinguem ausências conclusivas de caminho, confiam em envelopes verificados, mantêm as verificações de valor no mesmo turno e expõem fatos de comando não encontrado a partir do stderr.
- A virtualização da transcrição do desktop agora fixa os pontos finais da seleção de texto nativa durante a rolagem automática do arraste, enquanto os lançadores de utilitários alinham seu ícone e texto em linhas dimensionadas pelo conteúdo.

## v0.9.120 - 2026-08-11

- As tarefas de shell em segundo plano agora retêm sua sessão dona e o daemon depois que todas as vistas se desanexam, de modo que a remoção por inatividade não pode cancelar a tarefa antes de a conclusão ser entregue.

## v0.9.119 - 2026-08-11

- Os builds de reprodutibilidade do Native Graph e do Token agora rodam em runners independentes em paralelo, enquanto os uploads de DMG e ZIP do macOS Intel se sobrepõem e abandonam prontamente transferências travadas.
- A navegação de projetos do desktop, as superfícies de utilitários, o foco da transcrição e o comportamento da virtualização incorporada foram refinados, junto com estilos mais rígidos de execução de ferramentas e reutilização de processos do sistema de arquivos.
- O tratamento de anexos do Discord e do Telegram preserva a entrega limitada de mídia e valida diretamente o comportamento de upload do Telegram.

## v0.9.118 - 2026-08-11

- O desktop consolida Agentes, Busca e Controle de Código-Fonte no dock de utilitários, mantém Utilitários selecionado ao lançar ferramentas e alinha o tratamento de aviso versus falha entre cartões de ferramentas restaurados e ativos.
- A listagem de arquivos e a busca nativa agora combinam enumerações concorrentes, aceitam requisições persistentes canceláveis e snapshots de processos, e preservam o comportamento de fallback limitado sob forte fan-out do sistema de arquivos.
- O agrupamento do code-graph, a reutilização de standby do PowerShell, o rastreamento da árvore de processos do shell e a invalidação de cache foram reforçados contra trabalho concorrente e estado obsoleto.

## v0.9.117 - 2026-08-11

- O envio de prompts no desktop agora aceita o enfileiramento imediato com Enter e a restauração precisa, com Esc, do texto e dos anexos pendentes, enquanto a rolagem da transcrição adia as correções do virtualizador durante o movimento ativo do leitor.
- Os Utilitários do desktop agora apresentam lançadores diretos de Studio, Terminal e Explorer com descrições localizadas, enquanto a barra de atividades usa a identidade criativa de Utilitários e uma apresentação de uso renovada.
- As ações de canal obsoletas voltadas ao modelo e sua infraestrutura de despacho ao provedor foram removidas, de modo que o catálogo de ferramentas anunciado corresponde à superfície do runtime.
- A orientação de execução de ferramentas reforça as evidências agrupadas e a verificação no mesmo turno, enquanto rajadas concorrentes de sistema de arquivos, grafo, patch e shell ganham tratamento limitado de threadpool, faixa de spawn e pressão de alcançabilidade.

## v0.9.116 - 2026-08-11

- A análise de rodadas H5 do Terminal-Bench adiciona rastros de tarefas recompensadas e contagens agregadas de rodadas para a comparação final de alto esforço.

## v0.9.115 - 2026-08-11

- A análise de rodadas H4 do Terminal-Bench registra sondagens bem-sucedidas de tarefas de alto esforço e sua cadência de recuperação, patch e verificação.
- A orientação de execução de ferramentas agora trata fatos da tarefa e verificações comprovadas como estado conhecido durável e mantém a verificação do patch no mesmo turno de execução.

## v0.9.114 - 2026-08-11

- As identidades de ferramentas presumidas agora são verificadas antes das chamadas dependentes, com uma análise de rodadas H3 do Terminal-Bench registrando os padrões de recuperação resultantes.

## v0.9.113 - 2026-08-11

- A orientação de ferramentas agora agrupa amostras distintas de evidência e evita ativação redundante de ferramentas adiadas ou de projetos, com a análise de rodadas do Terminal-Bench capturando os padrões seriais restantes de sondagem.

## v0.9.112 - 2026-08-11

- As superfícies de utilitários, atividade, transcrição, configurações e repositório do desktop foram simplificadas em torno de uma configuração de recursos focada e de regressões compactas.
- A recuperação de provedores, os diagnósticos de shell/listagem e a verificação de releases foram consolidados em suítes menores e críticas para o envio, sem enfraquecer seus contratos de transporte, recursos ou empacotamento.

## v0.9.111 - 2026-08-11

- A navegação no repositório agora usa a superfície direta de ferramentas integradas, sem um agente explorador separado, reduzindo a sobrecarga de roteamento e a configuração legada.
- As decisões de nova tentativa do WebSocket da OpenAI preservam os erros atuais de autenticação, limitação e cancelamento, enquanto a recuperação do transporte de sessões e a desduplicação de conclusões foram reforçadas.
- O agrupamento de ferramentas, o fan-out de grafos, o relatório de progresso e o comportamento da transcrição, das configurações e do dock de utilitários do desktop foram simplificados, com regressões focadas.
- Os perfis do Terminal-Bench 2.1, as execuções retomáveis, os snapshots imutáveis do harness e a contabilidade de custos foram reforçados para comparações nativas reproduzíveis.

## v0.9.110 - 2026-08-11

- Os transportes de provedores agora limitam travamentos sem stream da Anthropic, distinguem falhas de transporte com nova tentativa das recusas do modelo, preservam a continuidade de raciocínio da OpenAI na recuperação e pré-aquecem sessões WebSocket compatíveis.
- As ferramentas de patch, listagem e shell recuperam divergências únicas de caminho ou contexto em uma só chamada, mantendo as proteções contra ambiguidade, links simbólicos e comandos destrutivos.
- A conclusão de títulos de sessão e o tratamento do fallback de origem Markdown estão mais resilientes, com regressões focadas de provedor, renderer, ferramenta e roteamento.
- Os diagnósticos do Terminal-Bench 2.1, as linhas de base nativas justas, a contabilidade de uso e os experimentos reproduzíveis de replay de raciocínio foram ampliados.

## v0.9.109 - 2026-08-10

- Os comandos de shell que terminam com saída diferente de zero são tratados como resultados de comando, e não como falhas de ferramenta, com status consistente no runtime e no TUI.
- O roteamento de ferramentas, os limites do explorador, os contratos de estilo de saída e suas suítes de regressão foram reforçados para evitar trabalho redundante, preservando relatórios concisos voltados ao usuário.
- As raízes de patch compactas agora estabelecem tanto o limite de gravação quanto o referencial de coordenadas de caminhos relativos, inclusive com uma orientação de recuperação mais clara.

## v0.9.108 - 2026-08-10

- A análise de patches compactos aceita invólucros legados Begin/End em torno de seções compactas, deixando inalterada a entrada V4A canônica.

## v0.9.107 - 2026-08-10

- As sessões de automação não interativa e de benchmark usam explicitamente o contexto de aprovação implícita, enquanto os workflows interativos mantêm seu portão de aprovação do usuário.

## v0.9.106 - 2026-08-10

- Os clientes MCP, a descoberta de ferramentas, as instruções, a execução, a atualização adiada e o encerramento são isolados por escopo de runtime, de modo que servidores de mesmo nome não podem vazar entre sessões concorrentes ou agentes independentes.

## v0.9.105 - 2026-08-10

- O acesso remoto é somente pelo app web: o pacote Capacitor/Android aposentado, as rotas de download de APK, os hooks de shell nativo e a ligação de versão de release do celular foram removidos, enquanto o deploy do relay ganha uma etapa explícita de preparação do renderer.
- As chamadas de ferramentas agora normalizam entradas do projeto atual para caminhos relativos compactos, rejeitam de forma consistente escopos divergentes ou redundantes e preservam a paridade entre os contratos de shell, patch, grafo, explore e ferramentas integradas.
- O relatório de contexto separa o uso visível pelo provedor da pressão de compactação e da reserva configurada, enquanto o thinking adaptativo da Anthropic deixa seu modo de exibição para a API, a menos que um operador o substitua explicitamente.
- Os rascunhos de nova tarefa mantêm sua própria aba de projeto ao selecionar ou registrar um projeto, e as mudanças bem-sucedidas de Fast na sessão alimentam o próximo rascunho correspondente sem substituir uma escolha de modelo diferente.

## v0.9.104 - 2026-08-09

- O roteamento de ferramentas agora localiza uma única vez as coordenadas desconhecidas do repositório, atribui cada faceta de evidência a uma ferramenta dedicada, agrupa apenas chamadas independentes e mantém as edições de texto e a verificação atrás da barreira de execução do patch.
- A inspeção de diretórios expõe dotfiles e metadados de arquivos sem exploração pelo Shell, enquanto os workflows sem delegação omitem o briefing do Lead não usado e adotam uma superfície de ferramentas menor e alinhada às capacidades.

## v0.9.103 - 2026-08-08

- A navegação, o campo de redação, o Studio, as configurações e as superfícies de transcrição do desktop agora compartilham um layout responsivo mais compacto, com um acompanhamento mais forte da rolagem virtual, tratamento de arquivos locais e cobertura ampliada de regressão do DOM.
- O renderer remoto é distribuído como um app web instalável, com manifesto estável, ícone e service worker apenas de rede, enquanto o relay serve esses recursos com os tipos de conteúdo exigidos de manifesto e service worker.
- A execução Solo não carrega mais as definições obsoletas de agentes de depurador, tarefa de agendador ou manipulador de webhook e remove seu protocolo obsoleto de roteamento/cache, mantendo os serviços integrados separados dos agentes personalizados editáveis.
- A geração de imagens hospedada do Codex seleciona explicitamente a ferramenta de imagem nos modelos compatíveis, com cobertura focada do corpo da requisição.

## v0.9.102 - 2026-08-08

- Incremento de versão de manutenção; sem mudanças funcionais em relação à v0.9.101.

## v0.9.101 - 2026-08-08

- Escape agora recupera para o campo de redação as mensagens enfileiradas ainda não processadas antes de qualquer outra coisa — primeiro a ordem da fila — de modo que um Esc no meio do turno edita o acompanhamento em espera em vez de interromper o turno; um segundo pressionamento ainda cancela.
- Os workflows são definições puras de estilo de trabalho: os pacotes não carregam mais uma lista de agentes. Todo agente definido (integrado e personalizado) está disponível para qualquer workflow que delega, o Solo permanece sem delegação por meio de `delegation: none`, e excluir um agente personalizado o remove de todas as superfícies de uma vez, inclusive do spawn por nome.
- Configurações → Geral ganhou chaves independentes de Busca na web, Explorer e Memória; a Memória agora controla as ferramentas de memória/recall mais a injeção da memória Core, enquanto os ciclos de memória em segundo plano passaram a Contexto como chave própria.
- As execuções headless de papéis e as sessões de benchmark começam com explorer, busca na web e memória desativados (superfície clássica) e as reativam por execução por meio de flags ou variáveis MIXDOG_FEATURE_*.
- A política de ferramentas compartilhada abandona a rodada obrigatória de verificação pós-edição, usa a evidência suficiente mais barata por consulta e define explore como uma busca simples de código-fonte em árvores e arquivos de código, com um alvo concreto por consulta.

## v0.9.100 - 2026-08-07

- O estilo do comando de contexto não depende mais de abrir primeiro as Configurações nem colide com a classe global de contexto do Monaco, e o reencaixe da transcrição não desfaz mais um pequeno movimento da roda do leitor.
- Os empacotadores do desktop agora restauram os downloads do npm com uma chave de cache apenas de dependências, de modo que os carimbos de versão da release não iniciam a frio toda instalação de plataforma.
- Os rascunhos ocultos são tratados como trabalho retomável, e não como releases publicadas, impedindo que releases com falha consumam uma versão de patch extra.

## v0.9.99 - 2026-08-07

- A tipografia da transcrição do desktop agora separa conteúdo, status operacional e metadados em uma hierarquia mais estável, enquanto o Fast usa um ícone compacto com estado.
- A recuperação do Explorer agora distribui uma vez cada faceta concreta de localização, preserva literalmente os caminhos retornados e interrompe a recuperação limitada em vez de retornar uma âncora fraca ou reconstruída.
- As leituras síncronas do catálogo de modelos não iniciam mais uma requisição de rede global implícita. O aquecimento da sessão continua sendo o único dono da E/S do catálogo remoto, de modo que os transportes injetados pelo provedor permanecem herméticos em uma instalação a frio.
- A faixa de release isolada agora prepara explicitamente um único runtime nativo verificado do code-graph, em vez de depender de um binário ambiente deixado por um job anterior.
- Os recursos de release do macOS Intel usam uploads HTTP/1.1 limitados, arquivo por arquivo, com verificações de conclusão remota e novas tentativas, impedindo que uma transferência travada do CLI segure indefinidamente a release inteira.
- A recuperação de releases não publicadas da mesma versão agora incorpora suas notas acumuladas a essa versão antes de publicar, em vez de deixar o trabalho distribuído marcado como Unreleased.

## v0.9.98 - 2026-08-07

- O pareamento remoto do navegador agora estabelece um canal criptografado de ponta a ponta autenticado antes que qualquer estado de sessão, dado de terminal ou carga RPC possa atravessar o relay; as faixas de mídia não criptografadas permanecem fechadas.
- Os anexos do desktop preservam a identidade e os metadados dos arquivos através do limite da sessão, com extração limitada de imagem/PDF e normalização de mídia compartilhada para as entradas dos provedores.
- O onboarding do desktop e os textos de configurações relacionados foram localizados em todos os idiomas distribuídos, enquanto a composição de IME, o acompanhamento virtual da transcrição e os controles do modo fast se comportam de forma consistente em painéis de longa duração.
- A recuperação de sessões, a entrega de mensagens pendentes, o cache do catálogo de provedores, a geração de títulos, os snapshots de worktrees e as métricas limitadas de runtime foram reforçados em torno do serviço de sessões unificado.
- A validação de releases é dividida em faixas paralelas, a compilação do desktop se sobrepõe aos portões, os runtimes preparados são armazenados em cache, e os pacotes de plataforma são enviados a um único rascunho oculto antes da publicação atômica. As dependências exclusivas do renderer não são mais duplicadas no arquivo do desktop, reduzindo o instalador do Windows em cerca de um terço.

## v0.9.97 - 2026-08-07

- O protocolo de sessão 1 agora carrega um índice explícito de compatibilidade, permitindo que clientes mais novos rejeitem daemons mais antigos, enquanto clientes mais antigos podem se conectar pela superfície de compatibilidade suportada sem pilhas paralelas de engine/backend.
- Os fluxos de desktop, terminal, canal, OAuth e memória agora compartilham o daemon de sessões unificado de toda a máquina; transportes, fallbacks e shims de compatibilidade obsoletos de engine/backend foram removidos da linha de desenvolvimento.
- A propriedade de sessões e os portões de carga de ferramentas agora coordenam o trabalho paralelo de shell, patch, leitura, code-graph, memória e canais com admissão justa, menos E/S duplicada e cobertura mais forte de cancelamento/recuperação.
- O foco de vários painéis no desktop, o arrastar de abas, o estado de revisão, as notificações, a nomenclatura de provedores, os diagnósticos do atualizador e o empacotamento de atualizações de desenvolvimento foram reforçados, com testes de regressão ampliados de renderer e de transporte de sessões.
- Os comandos de reprodução do Terminal-Bench e a validação de custos agora apontam para a execução arquivada exata e falham com clareza quando um conjunto de tentativas solicitado está ausente.

## v0.9.96 - 2026-08-07

- A disciplina de release agora exige que todo pacote de app seja pré-incrementado quando o protocolo de rede do engine muda, mantém sincronizadas as versões do workspace e publica essa identidade pendente sem um segundo incremento acidental.
- As superfícies de desenvolvimento e instaladas continuam compartilhando o armazenamento existente de dados e de autenticação; a disciplina de protocolo/versão impede a divergência de daemons de mesma versão sem esconder as credenciais atrás de um novo perfil.
- A validação de releases agora controla o empacotamento por plataforma e remove uma execução duplicada do code-graph, evitando cinco jobs de pacote caros quando um portão focado falha.
- Os conflitos de protocolo do desktop agora explicam o caminho de recuperação de atualizar/fechar e reabrir, em vez de exibir uma exceção bruta de transporte de sessão.
- O daemon unificado do protocolo 1 remove o host de sessões duplicado do desktop, restaura o comportamento de reconexão/ressincronização do daemon e preserva o trabalho de ferramentas concluído entre os limites de timeout e cancelamento.

## v0.9.95 - 2026-08-06

- Um processo global da máquina é dono de toda sessão ativa, e o TUI do terminal mais toda janela do desktop se conectam como vistas sobre um transporte HTTP+SSE em 127.0.0.1, de modo que não há papel de dono/espectador a negociar entre as superfícies.
- Os prompts enviados não podem mais se perder entre superfícies. O envio de uma vista do daemon mantém sua resposta síncrona, mas é repetido até o engine aceitá-lo (e reentregue após uma reinicialização do daemon), um envio por live-share é confirmado pelo dono e recorre ao spool durável quando é recusado ou não confirmado, e a fila descarta um id de envio reentregue em vez de postar a mensagem duas vezes.
- Edição entre clientes: retomar uma sessão que outra vista já mantém adota aquele engine ativo em vez de carregar uma segunda cópia, os quadros do engine se distribuem a todas as vistas, e um engine só termina com a ÚLTIMA vista — de modo que um terminal e uma janela do desktop podem conduzir uma sessão turno a turno.

## v0.9.94 - 2026-08-05

- A faixa de abas do desktop encolhe as abas em conjunto em direção aos pisos de ativa/inativa, com todas as abas visíveis em vez de rolar, e os shells de toque colapsam para uma lista de alternância com título + contagem.
- O markdown em streaming corrige a cauda ativa (`**`, `` ` ``, `~~` não fechados) e limita o bloqueio de geometria do código em bloco ao seu próprio chunk, de modo que títulos, listas e negrito são formatados enquanto o modelo ainda está digitando.
- A revisão do turno passou para a linha do tempo rolável (os diffs do turno acompanham a thread), encerrando o deslocamento da pilha do campo de redação ao entrar na sessão; os avisos de tom de alerta agora usam o par de status âmbar em vez do neutro.
- A faixa de legenda nativa é transparente, de modo que a barra de título do DOM e os véus das caixas de diálogo a escurecem diretamente; o par ◀ ▶ de ciclo de painéis foi aposentado (Alt+Left/Right mantém o ciclo de foco) e as caixas de diálogo de projetos assumem o pedido de escurecimento da barra de título.
- A captura da interface do desktop conduz Nova tarefa e Configurações por Ctrl+N / Ctrl+,, fixa o idioma da captura e verifica o layout estreito de 360px das configurações.
- Refinamentos do harness de janela e jitter da transcrição do TUI, além de sondas de corrida de seleção de sessão no desktop.

## v0.9.93 - 2026-08-04

- Auditoria de dependências zerada no core e no desktop: `npm audit fix` para fast-uri, ip-address, hono/@hono/node-server, undici raiz e brace-expansion; a substituição aninhada de undici do discord.js foi elevada para 6.28.0; a substituição `^3.4.12` do `dompurify` do desktop resolve o lote de XSS do Monaco.
- Auditoria de recursos do README: seção da bancada do desktop, detalhes do subsistema de memória, pareamento por QR do relay, cron com horário de silêncio e transcrição local com Whisper, sessões de painéis paralelos, assistente de onboarding.
- Discord: removido o último comando com barra registrado (`/stop`); a inicialização ainda limpa os conjuntos obsoletos de comandos globais/de guild.
- Terminal-Bench 2.1: resultados corrigidos, gráficos de comparação substitutos e scripts de reprodução/verificação.
- CI: o Deploy agora é o único ponto de entrada de release (a cadeia de suprimentos de tokens foi incorporada, as portas laterais de push de tag foram removidas) com um portão de release de changelog.
- Versões de pacotes unificadas em 0.9.92 (celular/relay alinhados) e histórico do repositório condensado em uma raiz limpa.

## v0.9.92 - 2026-08-02

- Release de base: pacote npm, instaladores do desktop e recursos nativos da cadeia de suprimentos (runtime, patch, graph, token, runtime de voz).

