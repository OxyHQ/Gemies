import { EXTERNAL_PAIRING_TTL_MS } from '../../domain/external-agent.js';

export type InviteLocale = 'en' | 'es';

export function inviteLocaleOf(value: unknown): InviteLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** The command the pasted text runs; `@latest`, so a machine never pairs with a retired daemon. */
function connectCommand(code: string): string {
  return `npx -y @alia-codea/cli@latest connect ${code} --cli <claude|codex|opencode>`;
}

/**
 * The text a person pastes into Claude Code, Codex or OpenCode (ADR 0030, ADR 0038).
 *
 * Self-sufficient: it carries a single-use code and one command, and nothing else is needed — no
 * sign-in, no account, no configuration. The code is the authorisation; redeeming it leaves the
 * machine a credential for this one agent. It is written to be read by a model, so it says what to
 * run, what it leaves running (a per-user service, so the agent stays connected on its own), what
 * to report and when to stop.
 */
export function buildInvitePrompt(input: { code: string; locale: InviteLocale }): string {
  const minutes = Math.round(EXTERNAL_PAIRING_TTL_MS / 60_000);
  const command = connectCommand(input.code);
  if (input.locale === 'es') {
    return [
      'Quiero conectarte a Gemies (https://gemies.ai) como uno de mis gemies, para hablar contigo desde allí y que mis otros gemies te escriban.',
      '',
      'Ejecuta este comando en este equipo, desde la carpeta en la que quiero que trabajes (podrás editar archivos ahí):',
      '',
      `  ${command}`,
      '',
      'Sustituye <claude|codex|opencode> por el que seas tú. No pide iniciar sesión en ningún sitio: el código es la autorización.',
      'Empareja este equipo e instala un servicio de mi usuario que te mantiene conectado aunque cierres esta sesión o reinicies el equipo, y termina cuando muestra "Connected". Entonces dímelo y no hagas nada más: desde ahí el servicio atiende los mensajes de Gemies usando esta misma herramienta, con mi cuenta.',
      'Si tu sandbox no deja salir a la red o instalar ese servicio de usuario, pídeme permiso para ejecutarlo fuera de él.',
      `El código es de un solo uso y caduca en ${minutes} minutos. No instales nada más ni cambies ninguna otra configuración.`,
    ].join('\n');
  }
  return [
    "I'm connecting you to Gemies (https://gemies.ai) as one of my gemies, so I can talk to you from there and my other gemies can message you.",
    '',
    'Run this command on this machine, from the folder I want you to work in (you will be able to edit files there):',
    '',
    `  ${command}`,
    '',
    'Replace <claude|codex|opencode> with whichever one you are. It asks for no sign-in anywhere: the code is the authorisation.',
    'It pairs this machine and installs a service for my user that keeps you connected after this session ends and after a restart, and it returns once it prints "Connected". Then tell me and do nothing else — from then on that service answers Gemies\' messages using this same tool, signed in as me.',
    'If your sandbox blocks network access or installing that user service, ask me to approve running it outside the sandbox.',
    `The code is single-use and expires in ${minutes} minutes. Do not install anything else or change any other configuration.`,
  ].join('\n');
}
