import type { Email } from './mailer.js';

export type Language = 'ru' | 'en';

/** The "forgot password" email, in the language the app is set to. */
export function resetCodeEmail(to: string, code: string, language: Language): Email {
  // "482913" → "482 913": easier to read off and type.
  const shown = `${code.slice(0, 3)} ${code.slice(3)}`;
  if (language === 'ru') {
    return {
      to,
      subject: `Код для сброса пароля Backpack: ${shown}`,
      text: [
        'Здравствуйте!',
        '',
        `Ваш код для сброса пароля в Backpack: ${shown}`,
        '',
        'Код действует 15 минут. Введите его в приложении вместе с новым паролем.',
        '',
        'Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо — пароль останется прежним.',
      ].join('\n'),
    };
  }
  return {
    to,
    subject: `Your Backpack password reset code: ${shown}`,
    text: [
      'Hi,',
      '',
      `Your Backpack password reset code: ${shown}`,
      '',
      'It works for 15 minutes. Enter it in the app along with your new password.',
      '',
      "If you didn't ask to reset your password, just ignore this email — your password stays the same.",
    ].join('\n'),
  };
}
