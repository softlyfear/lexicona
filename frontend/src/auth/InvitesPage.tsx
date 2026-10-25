import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AuthClient } from './client';
import type { InvitesResource } from './invites';
import styles from './AccountPage.module.css';

const states = {
  active: 'Действует',
  used: 'Использовано',
  revoked: 'Отозвано',
  expired: 'Истекло',
};
function InvitesView({ resource }: { resource: InvitesResource }) {
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  const next = state.next;
  return (
    <section aria-busy={state.loading || state.busy}>
      <h1>Приглашения</h1>
      <p>
        Общий административный список, не личные словари пользователей. Срок
        действия — 72 часа. Время показано в UTC. Размер страницы — 2.
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={state.busy}
          onClick={() => {
            void resource.create();
          }}
        >
          Создать приглашение
        </button>
        <button
          type="button"
          disabled={state.loading || state.busy}
          onClick={() => {
            void resource.load();
          }}
        >
          Обновить список
        </button>
      </div>
      <p role="alert">{state.message}</p>
      {state.token !== null && (
        <section className={styles.secret} aria-labelledby="secret-heading">
          <h2 id="secret-heading">Одноразовый код приглашения</h2>
          <p>
            Показывается только сейчас. Уход со страницы удалит код из памяти
            приложения; список и перезагрузка его не восстановят.
          </p>
          <output aria-label="Одноразовый код приглашения">
            {state.token}
          </output>
          <button
            type="button"
            onClick={() => {
              void resource.copy(async (token) => {
                await navigator.clipboard.writeText(token);
              });
            }}
          >
            Скопировать код
          </button>
        </section>
      )}
      {state.loading ? (
        <p>Загружаем приглашения…</p>
      ) : !state.loaded ? (
        <p>Список ещё не загружен.</p>
      ) : state.items.length === 0 ? (
        <p>Приглашений на этой странице нет.</p>
      ) : (
        <ul className={styles.invites}>
          {state.items.map((invite) => (
            <li key={invite.id}>
              <h2>{states[invite.state]}</h2>
              <dl>
                <dt>ID</dt>
                <dd>{invite.id}</dd>
                <dt>Создал</dt>
                <dd>{invite.created_by ?? 'Аккаунт удалён'}</dd>
                <dt>Создано (UTC)</dt>
                <dd>
                  <time dateTime={invite.created_at}>{invite.created_at}</time>
                </dd>
                <dt>Истекает (UTC)</dt>
                <dd>
                  <time dateTime={invite.expires_at}>{invite.expires_at}</time>
                </dd>
                {invite.used_at !== null && (
                  <>
                    <dt>Использовано (UTC)</dt>
                    <dd>
                      <time dateTime={invite.used_at}>{invite.used_at}</time>
                    </dd>
                  </>
                )}
                {invite.revoked_at !== null && (
                  <>
                    <dt>Отозвано (UTC)</dt>
                    <dd>
                      <time dateTime={invite.revoked_at}>
                        {invite.revoked_at}
                      </time>
                    </dd>
                  </>
                )}
                <dt>Версия</dt>
                <dd>{invite.version}</dd>
              </dl>
              <button
                type="button"
                disabled={state.busy || invite.state !== 'active'}
                onClick={() => {
                  void resource.revoke(invite);
                }}
              >
                Отозвать
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={state.loading || state.busy || state.next === null}
        onClick={
          next === null
            ? undefined
            : () => {
                void resource.load(next);
              }
        }
      >
        Следующая страница
      </button>
      <p>
        Секреты отсутствуют в списке. При неизвестном результате создания
        обновите список: лишнее можно отозвать, но восстановить секрет нельзя.
      </p>
    </section>
  );
}
export function InvitesPage({ client }: { client: AuthClient }) {
  const [resource, setResource] = useState<InvitesResource | null>(null);
  useEffect(() => {
    const next = client.openInvites();
    const unsubscribe = next.subscribe(() => {
      setResource(next);
    });
    void next.load();
    return () => {
      unsubscribe();
      next.dispose();
    };
  }, [client]);
  return resource === null ? (
    <p>Открываем приглашения…</p>
  ) : (
    <InvitesView resource={resource} />
  );
}
