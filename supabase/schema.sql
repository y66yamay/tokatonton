-- =====================================================================
-- tokatonton: 予定調整アプリのデータベース定義
--
-- 使い方: Supabase の SQL Editor にこのファイルの内容を貼り付けて実行する。
--   何度実行しても同じ状態になるように書いてある（既存データは消えない）。
--
-- 方針:
--   - テーブルは RLS を有効にしてポリシーを作らない → 直接の読み書きは不可
--   - 画面からの操作はすべて public スキーマの関数（RPC）経由で行う
--   - 幹事の操作には幹事トークンが必要。DB にはハッシュだけを保存する
--   - 日付・時刻は「日本時間の壁時計の値」としてタイムゾーンなしで保存する
-- =====================================================================


-- ---------------------------------------------------------------------
-- テーブル
-- ---------------------------------------------------------------------

create table if not exists public.events (
    id uuid primary key default gen_random_uuid(),
    title text not null check (char_length(title) between 1 and 200),
    description text not null default '' check (char_length(description) <= 5000),
    deadline date,                    -- 回答締切日（この日の終わりまで回答できる）
    decided_candidate_id uuid,        -- 確定した候補（未確定なら null）
    admin_token_hash text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.candidates (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events (id) on delete cascade,
    date date not null,
    start_time time,                  -- null なら終日
    end_time time,                    -- null なら終了時刻なし
    check (end_time is null or (start_time is not null and end_time > start_time))
);

create index if not exists candidates_event_id_idx on public.candidates (event_id);

-- events.decided_candidate_id は candidates を参照するので、後から外部キーを付ける
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'events_decided_candidate_id_fkey'
    ) then
        alter table public.events
            add constraint events_decided_candidate_id_fkey
            foreign key (decided_candidate_id)
            references public.candidates (id) on delete set null;
    end if;
end
$$;

create table if not exists public.responses (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events (id) on delete cascade,
    name text not null check (char_length(name) between 1 and 100),
    comment text not null default '' check (char_length(comment) <= 1000),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists responses_event_id_idx on public.responses (event_id);

create table if not exists public.answers (
    response_id uuid not null references public.responses (id) on delete cascade,
    candidate_id uuid not null references public.candidates (id) on delete cascade,
    value text not null check (value in ('yes', 'maybe', 'no')),
    primary key (response_id, candidate_id)
);

create index if not exists answers_candidate_id_idx on public.answers (candidate_id);


-- テーブルへの直接アクセスを禁止する
alter table public.events enable row level security;
alter table public.candidates enable row level security;
alter table public.responses enable row level security;
alter table public.answers enable row level security;

revoke all on table public.events, public.candidates, public.responses, public.answers
    from anon, authenticated;


-- ---------------------------------------------------------------------
-- 内部用の関数（API としては公開しない）
-- ---------------------------------------------------------------------

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;


-- トークンのハッシュ値
create or replace function app_private.hash_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
    select encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;


-- 幹事トークンを確認し、違っていればエラーにする
create or replace function app_private.require_admin(p_event_id uuid, p_admin_token text)
returns void
language plpgsql
set search_path = ''
as $$
begin
    if not exists (
        select 1
        from public.events
        where id = p_event_id
          and admin_token_hash = app_private.hash_token(coalesce(p_admin_token, ''))
    ) then
        raise exception '幹事用URLが正しくありません';
    end if;
end;
$$;


-- 候補日時のリストを保存する
--   p_candidates: [{"id": 既存候補のid（新規なら省略）, "date": "2026-11-05",
--                   "start_time": "10:00", "end_time": "11:00"}, ...]
--   リストにない既存候補は削除する（その候補への回答も消える）。
create or replace function app_private.save_candidates(p_event_id uuid, p_candidates jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
    item jsonb;
    kept_ids uuid[] := '{}';
    candidate_id uuid;
begin
    if jsonb_typeof(p_candidates) is distinct from 'array'
       or jsonb_array_length(p_candidates) = 0 then
        raise exception '候補日時を1つ以上指定してください';
    end if;

    if jsonb_array_length(p_candidates) > 100 then
        raise exception '候補日時は100件までです';
    end if;

    for item in select value from jsonb_array_elements(p_candidates)
    loop
        candidate_id := nullif(item ->> 'id', '')::uuid;

        if candidate_id is not null then
            update public.candidates
            set date = (item ->> 'date')::date,
                start_time = nullif(item ->> 'start_time', '')::time,
                end_time = nullif(item ->> 'end_time', '')::time
            where id = candidate_id
              and event_id = p_event_id;

            if not found then
                raise exception '存在しない候補日時が指定されました';
            end if;
        else
            insert into public.candidates (event_id, date, start_time, end_time)
            values (
                p_event_id,
                (item ->> 'date')::date,
                nullif(item ->> 'start_time', '')::time,
                nullif(item ->> 'end_time', '')::time
            )
            returning id into candidate_id;
        end if;

        kept_ids := kept_ids || candidate_id;
    end loop;

    delete from public.candidates
    where event_id = p_event_id
      and not (id = any (kept_ids));
end;
$$;


revoke all on all functions in schema app_private from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 公開 API（画面から RPC で呼ぶ関数）
-- ---------------------------------------------------------------------

-- イベントを作成する。戻り値: {"id": ..., "admin_token": ...}
create or replace function public.create_event(
    p_title text,
    p_description text,
    p_deadline date,
    p_candidates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    new_event_id uuid;
    admin_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
    insert into public.events (title, description, deadline, admin_token_hash)
    values (
        trim(p_title),
        coalesce(p_description, ''),
        p_deadline,
        app_private.hash_token(admin_token)
    )
    returning id into new_event_id;

    perform app_private.save_candidates(new_event_id, p_candidates);

    return jsonb_build_object('id', new_event_id, 'admin_token', admin_token);
end;
$$;


-- イベントの内容（候補日時・回答を含む）を取得する。見つからなければ null。
create or replace function public.get_event(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'description', e.description,
        'deadline', e.deadline,
        'is_closed', e.deadline is not null
                     and e.deadline < (now() at time zone 'Asia/Tokyo')::date,
        'decided_candidate_id', e.decided_candidate_id,
        'created_at', e.created_at,
        'candidates', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', c.id,
                    'date', c.date,
                    'start_time', to_char(c.start_time, 'HH24:MI'),
                    'end_time', to_char(c.end_time, 'HH24:MI')
                )
                order by c.date, c.start_time nulls first, c.end_time nulls first
            )
            from public.candidates c
            where c.event_id = e.id
        ), '[]'::jsonb),
        'responses', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', r.id,
                    'name', r.name,
                    'comment', r.comment,
                    'updated_at', r.updated_at,
                    'answers', coalesce((
                        select jsonb_object_agg(a.candidate_id, a.value)
                        from public.answers a
                        where a.response_id = r.id
                    ), '{}'::jsonb)
                )
                order by r.created_at
            )
            from public.responses r
            where r.event_id = e.id
        ), '[]'::jsonb)
    )
    from public.events e
    where e.id = p_event_id;
$$;


-- 回答を保存する。p_response_id が null なら新規、指定があれば上書き。
--   p_answers: {"候補id": "yes" | "maybe" | "no", ...}
-- 戻り値: 回答の id
create or replace function public.save_response(
    p_event_id uuid,
    p_response_id uuid,
    p_name text,
    p_comment text,
    p_answers jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_id uuid := p_response_id;
    event_deadline date;
begin
    select deadline into event_deadline
    from public.events
    where id = p_event_id;

    if not found then
        raise exception 'イベントが見つかりません';
    end if;

    if event_deadline is not null
       and event_deadline < (now() at time zone 'Asia/Tokyo')::date then
        raise exception '回答の締切を過ぎています';
    end if;

    if jsonb_typeof(p_answers) is distinct from 'object' then
        raise exception '回答の形式が正しくありません';
    end if;

    if target_id is null then
        insert into public.responses (event_id, name, comment)
        values (p_event_id, trim(p_name), coalesce(p_comment, ''))
        returning id into target_id;
    else
        update public.responses
        set name = trim(p_name),
            comment = coalesce(p_comment, ''),
            updated_at = now()
        where id = target_id
          and event_id = p_event_id;

        if not found then
            raise exception '回答が見つかりません';
        end if;

        delete from public.answers where response_id = target_id;
    end if;

    -- このイベントの候補に対する回答だけを保存する
    insert into public.answers (response_id, candidate_id, value)
    select target_id, c.id, a.value
    from jsonb_each_text(p_answers) as a (key, value)
    join public.candidates c
      on c.id::text = a.key
     and c.event_id = p_event_id;

    return target_id;
end;
$$;


-- 幹事トークンが正しいかを返す（画面で幹事モードにするかの判定用）
create or replace function public.check_admin(p_event_id uuid, p_admin_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.events
        where id = p_event_id
          and admin_token_hash = app_private.hash_token(coalesce(p_admin_token, ''))
    );
$$;


-- [幹事] イベントの内容と候補日時を更新する
create or replace function public.update_event(
    p_event_id uuid,
    p_admin_token text,
    p_title text,
    p_description text,
    p_deadline date,
    p_candidates jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform app_private.require_admin(p_event_id, p_admin_token);

    update public.events
    set title = trim(p_title),
        description = coalesce(p_description, ''),
        deadline = p_deadline,
        updated_at = now()
    where id = p_event_id;

    perform app_private.save_candidates(p_event_id, p_candidates);
end;
$$;


-- [幹事] 日程を確定する。p_candidate_id を null にすると確定を取り消す。
create or replace function public.decide_event(
    p_event_id uuid,
    p_admin_token text,
    p_candidate_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform app_private.require_admin(p_event_id, p_admin_token);

    if p_candidate_id is not null and not exists (
        select 1 from public.candidates
        where id = p_candidate_id and event_id = p_event_id
    ) then
        raise exception '候補日時が見つかりません';
    end if;

    update public.events
    set decided_candidate_id = p_candidate_id,
        updated_at = now()
    where id = p_event_id;
end;
$$;


-- [幹事] 回答を削除する
create or replace function public.delete_response(
    p_event_id uuid,
    p_admin_token text,
    p_response_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform app_private.require_admin(p_event_id, p_admin_token);

    delete from public.responses
    where id = p_response_id
      and event_id = p_event_id;
end;
$$;


-- [幹事] イベントを削除する（候補日時・回答もすべて消える）
create or replace function public.delete_event(p_event_id uuid, p_admin_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform app_private.require_admin(p_event_id, p_admin_token);

    delete from public.events where id = p_event_id;
end;
$$;


-- 公開 API の実行権限は anon（未ログインの利用者）と authenticated にだけ与える
revoke all on function
    public.create_event(text, text, date, jsonb),
    public.get_event(uuid),
    public.save_response(uuid, uuid, text, text, jsonb),
    public.check_admin(uuid, text),
    public.update_event(uuid, text, text, text, date, jsonb),
    public.decide_event(uuid, text, uuid),
    public.delete_response(uuid, text, uuid),
    public.delete_event(uuid, text)
from public;

grant execute on function
    public.create_event(text, text, date, jsonb),
    public.get_event(uuid),
    public.save_response(uuid, uuid, text, text, jsonb),
    public.check_admin(uuid, text),
    public.update_event(uuid, text, text, text, date, jsonb),
    public.decide_event(uuid, text, uuid),
    public.delete_response(uuid, text, uuid),
    public.delete_event(uuid, text)
to anon, authenticated;
