# Dashboard Lucrativo

Dashboard de tracking first-party hospedado no Cloudflare Pages + D1.
Captura UTMs, registra compras via webhook e mostra tudo em um painel próprio — sem depender de ferramentas de terceiros.

---

## O que você tem aqui

- **Dashboard** com receita, vendas, ticket médio, UTM breakdown e compras recentes
- **Tracking de eventos** — PageView e InitiateCheckout via snippet HTML
- **Webhooks de compra** para Kiwify, Hotmart e Eduzz (purchase_log no banco)
- **Gerador de UTM** integrado no dashboard
- **Banco de dados próprio** no Cloudflare D1 — seus dados, sua conta, sem mensalidade de SaaS
- **Captura de UTMs automática** quando o domínio passa pelo Cloudflare

---

## Contas necessárias

| Conta | Custo | Para quê |
|---|---|---|
| Cloudflare | Grátis | Hospedagem + banco D1 |
| GitHub | Grátis | Repositório do código |

---

## Setup completo (passo a passo)

### 1. Pré-requisitos — instale uma vez só

```powershell
# Node.js (necessário para o Wrangler)
# Baixe em: https://nodejs.org  (versão LTS)

# GitHub CLI
# Baixe em: https://cli.github.com

# Depois de instalar, autentique:
gh auth login
npx wrangler login
```

### 2. Clone o template para a pasta do cliente

```powershell
cd "C:\onde\ficam\seus\projetos"
gh repo clone daianihemkemaier-max/dashboard-lucrativo nome-do-cliente
cd nome-do-cliente
```

### 3. Crie o banco D1

```powershell
npx wrangler d1 create nome-do-cliente-db
```

Anote o `database_id` que aparecer na resposta. Vai ser usado no próximo passo.

### 4. Configure o wrangler.toml

Copie o arquivo de exemplo e preencha:

```powershell
copy wrangler.toml.example wrangler.toml
```

Abra o `wrangler.toml` e preencha:

```toml
name = "nome-do-cliente"
compatibility_date = "2025-03-01"
pages_build_output_dir = "."

[[d1_databases]]
binding = "DB"
database_name = "nome-do-cliente-db"
database_id = "COLE_O_ID_AQUI"
```

> O `wrangler.toml` está no `.gitignore` — nunca será enviado pro GitHub.

### 5. Crie as tabelas no banco

```powershell
npx wrangler d1 migrations apply nome-do-cliente-db --remote
```

Confirme com `Y` quando perguntar.

### 6. Crie o repositório GitHub do cliente e faça push

```powershell
gh repo create daianihemkemaier-max/dashboard-nome-cliente --private
git remote set-url origin https://github.com/daianihemkemaier-max/dashboard-nome-cliente.git
git add .
git commit -m "Setup inicial"
git push -u origin main
```

### 7. Crie o projeto no Cloudflare Pages

1. Acesse [cloudflare.com](https://cloudflare.com) → **Pages → Create a project → Connect to Git**
2. Selecione o repositório recém criado
3. Build settings:
   - Framework preset: `None`
   - Build command: *(deixe vazio)*
   - Build output directory: `/`
4. Clique em **Save and Deploy**

> O Cloudflare vai dar um nome automático para o projeto (ex: `dashboard-nome-cliente`).
> A URL será `dashboard-nome-cliente.pages.dev`.

### 8. Conecte o banco D1

Cloudflare Pages → seu projeto → **Settings → Bindings → Add binding**

| Campo | Valor |
|---|---|
| Type | D1 Database |
| Variable name | `DB` |
| Database | selecione o banco criado no passo 3 |

### 9. Configure as variáveis de ambiente

Cloudflare Pages → seu projeto → **Settings → Environment variables → Add**

Selecione o ambiente **Production** e adicione:

| Variável | Valor | Como gerar |
|---|---|---|
| `DASH_KEY` | Senha do dashboard | Qualquer senha forte — ex: `cliente2026` |
| `KIWIFY_WEBHOOK_SLUG` | UUID aleatório | [uuidgenerator.net](https://www.uuidgenerator.net) |
| `HOTMART_WEBHOOK_SLUG` | UUID aleatório | [uuidgenerator.net](https://www.uuidgenerator.net) |
| `EDUZZ_WEBHOOK_SLUG` | UUID aleatório | [uuidgenerator.net](https://www.uuidgenerator.net) |

> Adicione apenas os slugs das plataformas que o cliente usa.

Após salvar → clique em **Redeploy**.

---

## O que entregar ao cliente

Após o setup, o cliente recebe:

```
URL do dashboard:  https://seu-projeto.pages.dev/dash?key=DASH_KEY
URL do webhook:    https://seu-projeto.pages.dev/webhook/kiwify/SEU-SLUG
                   https://seu-projeto.pages.dev/webhook/hotmart/SEU-SLUG
                   https://seu-projeto.pages.dev/webhook/eduzz/SEU-SLUG
```

---

## Snippets para o site do cliente

### Snippet principal — cola no `<head>` de toda página

Troque `SEU-PROJETO` pela URL do seu projeto Pages. O snippet faz tudo automaticamente:
captura UTMs, salva no banco com um ID de sessão (`trk`) e cola esse ID nos links de checkout
para que a plataforma devolva a origem no webhook de compra.

```html
<script>
  (function () {
    var BASE = 'https://SEU-PROJETO.pages.dev';

    // Gera ou recupera o ID de sessão persistente
    var trk = localStorage.getItem('_trk');
    if (!trk) {
      trk = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem('_trk', trk);
    }

    function getUTMs() {
      var p = new URLSearchParams(location.search);
      return {
        utm_source:   p.get('utm_source')   || '',
        utm_medium:   p.get('utm_medium')   || '',
        utm_campaign: p.get('utm_campaign') || '',
        utm_content:  p.get('utm_content')  || '',
        utm_term:     p.get('utm_term')     || ''
      };
    }

    function getCookie(name) {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    }

    // Salva UTMs + fbc/gclid + trk no banco para vincular à compra depois
    var utms = getUTMs();
    var p    = new URLSearchParams(location.search);
    fetch(BASE + '/checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(Object.assign({
        trk: trk,
        event_source_url: location.href,
        fbc:   getCookie('_fbc'),
        fbp:   getCookie('_fbp'),
        gclid: p.get('gclid') || getCookie('_gclid') || ''
      }, utms))
    }).catch(function(){});

    // Envia evento de tracking
    function track(eventName) {
      var id = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
      fetch(BASE + '/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          event_name: eventName,
          event_id: id,
          event_time: Math.floor(Date.now() / 1000),
          event_source_url: location.href,
          trk: trk,
          user_data: {},
          utm: utms
        })
      }).catch(function(){});
    }

    // Adiciona o trk nos links de checkout para a plataforma devolver no webhook
    function tagCheckoutLinks() {
      var rules = [
        { domain: 'pay.kiwify.com.br',   param: 'sck'   },
        { domain: 'pay.hotmart.com',      param: 'xcod'  },
        { domain: 'sun.eduzz.com',        param: 'code1' },
        { domain: 'checkout.eduzz.com',   param: 'code1' },
      ];
      document.querySelectorAll('a[href]').forEach(function (a) {
        rules.forEach(function (rule) {
          if (a.href.indexOf(rule.domain) !== -1) {
            try {
              var url = new URL(a.href);
              url.searchParams.set(rule.param, trk);
              a.href = url.toString();
            } catch (e) {}
          }
        });
      });
    }

    window._track = track;
    track('PageView');

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tagCheckoutLinks);
    } else {
      tagCheckoutLinks();
    }
  })();
</script>
```

### InitiateCheckout — chama no botão de compra

Após colar o snippet acima no `<head>`, basta adicionar `onclick` no botão:

```html
<button onclick="_track('InitiateCheckout')">Comprar agora</button>
```

---

## Como verificar que está funcionando

### PageView e InitiateCheckout
1. Abra a página do cliente no navegador
2. Pressione F12 → aba **Network** → filtre por `tracker`
3. Recarregue a página — deve aparecer um POST com **status 200**
4. Clique no botão de compra — deve aparecer um segundo POST com **status 200**

### Compra (webhook)
1. Faça um pedido de teste na plataforma do cliente
   - Kiwify: Produtos → seu produto → Criar pedido de teste
   - Hotmart: Ferramentas → Webhooks → Enviar teste
2. Abra o dashboard → **Compras recentes**
3. A compra deve aparecer na lista

---

## Captura de UTMs

O snippet acima já lê os UTMs direto da URL da página (`?utm_source=...`) e envia junto com cada evento — **sem nenhuma configuração extra**. Funciona em qualquer domínio, com ou sem Cloudflare.

---

## Próximos deploys (clientes novos)

Para cada novo cliente, repita os passos 2 a 9 com o nome do novo cliente.
Cada cliente tem seu próprio banco D1 e seu próprio projeto Pages — totalmente isolados.
