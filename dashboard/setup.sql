-- ───────────────────────────────────────────────────────────────────────────
--  Tabspace signup dashboard: the one thing you run in Supabase.
--
--  Paste this whole file into  supabase.com -> your project -> SQL Editor -> Run.
--  Nothing to fill in first. The last statement prints who it made admin.
--
--  Why a function instead of querying tables from the page:
--
--  Signup counts live in `auth.users`, which the anon key cannot read and must
--  never be able to read. The alternative -- putting the service_role key in
--  the dashboard -- would hand full admin access over your whole database to
--  anyone who opened the page or found the file. So the counting happens inside
--  the database instead, in a `security definer` function that runs with the
--  owner's rights, checks who is calling, and returns only what is listed here.
--
--  WHAT THIS RETURNS
--    - counts and dates about signups and sign-ins
--    - the email addresses of people who signed up, which you can already see
--      under Authentication -> Users, so this is not widening your access
--    - totals describing how big boards are: how many spaces, folders,
--      bookmarks and notes exist in total
--
--  `tabspace_stats` deliberately returns no board content: it counts containers
--  and selects no title, URL, tag or note text. `tabspace_export` in section 4
--  does return board content, and carries its own warning -- read it.
--
--  Passwords appear in neither. Supabase stores a bcrypt hash, not the
--  password, so there is nothing to read back, for anyone.
-- ───────────────────────────────────────────────────────────────────────────


-- ── 1. Who is allowed to read the numbers ──────────────────────────────────
--
-- A table rather than an email pasted into the function body: an address typed
-- into a file is a thing to get wrong once and then be locked out by, and
-- changing it later would mean re-running the whole function definition.

create table if not exists public.app_admins (
  email    text primary key,
  added_at timestamptz not null default now()
);

-- No policies are defined on purpose. Row-level security with no policy means
-- no one reaches this table through the API at all -- not anon, not a signed-in
-- user. Only the `security definer` function below can see it, because it runs
-- as the table's owner.
alter table public.app_admins enable row level security;


-- ── 2. Claim admin, without typing an address ──────────────────────────────
--
-- The first account ever created in this project is you: you made a test
-- account before anyone else could have found the extension. If this picks the
-- wrong one, fix it with the one-liner at the bottom of this file.

insert into public.app_admins (email)
select email
from auth.users
where email is not null
order by created_at
limit 1
on conflict (email) do nothing;


-- ── 3. The function the dashboard calls ────────────────────────────────────

create or replace function public.tabspace_stats()
returns jsonb
language plpgsql
security definer
-- Pinned search_path: a `security definer` function without one can be hijacked
-- by a caller who puts their own `auth` schema earlier on the path.
set search_path = public, auth, pg_temp
as $$
declare
  result jsonb;
  shape  record;
begin
  -- The anon key is public -- it ships inside the extension -- so being signed
  -- in is not on its own a permission. Only a listed address gets the numbers.
  if not exists (
    select 1 from public.app_admins where email = coalesce(auth.email(), '')
  ) then
    raise exception 'not authorised';
  end if;

  -- How big people's boards are, counted without reading them. This walks
  -- `boards.state` to count containers and keeps only the totals: no title,
  -- URL, tag or note text is selected anywhere, and nothing is grouped by user.
  select
    coalesce(sum(spaces), 0)                           as spaces,
    coalesce(sum(folders), 0)                          as folders,
    coalesce(sum(bookmarks), 0)                        as bookmarks,
    coalesce(sum(notes), 0)                            as notes,
    coalesce(round(avg(bookmarks)::numeric, 1), 0)     as avg_bookmarks,
    coalesce(max(bookmarks), 0)                        as max_bookmarks,
    coalesce(count(*) filter (where bookmarks = 0), 0) as empty_boards
  into shape
  from (
    select
      jsonb_array_length(coalesce(b.state -> 'spaces', '[]'::jsonb)) as spaces,

      (select count(*)
         from jsonb_array_elements(coalesce(b.state -> 'spaces', '[]'::jsonb)) sp
         cross join lateral jsonb_array_elements(coalesce(sp -> 'folders', '[]'::jsonb)) f
      ) as folders,

      -- bookmarks sitting in a folder, plus those nested inside a group
      (select count(*)
         from jsonb_array_elements(coalesce(b.state -> 'spaces', '[]'::jsonb)) sp
         cross join lateral jsonb_array_elements(coalesce(sp -> 'folders', '[]'::jsonb)) f
         cross join lateral jsonb_array_elements(coalesce(f -> 'items', '[]'::jsonb)) it
        where it ->> 'type' = 'bookmark'
      ) + (select count(*)
         from jsonb_array_elements(coalesce(b.state -> 'spaces', '[]'::jsonb)) sp
         cross join lateral jsonb_array_elements(coalesce(sp -> 'folders', '[]'::jsonb)) f
         cross join lateral jsonb_array_elements(coalesce(f -> 'items', '[]'::jsonb)) it
         cross join lateral jsonb_array_elements(coalesce(it -> 'groupItems', '[]'::jsonb)) gi
        where gi ->> 'type' = 'bookmark'
      ) as bookmarks,

      -- notes pinned in a folder, plus sticky notes on the board background
      (select count(*)
         from jsonb_array_elements(coalesce(b.state -> 'spaces', '[]'::jsonb)) sp
         cross join lateral jsonb_array_elements(coalesce(sp -> 'folders', '[]'::jsonb)) f
         cross join lateral jsonb_array_elements(coalesce(f -> 'items', '[]'::jsonb)) it
        where it ->> 'type' = 'note'
      ) + (select count(*)
         from jsonb_array_elements(coalesce(b.state -> 'spaces', '[]'::jsonb)) sp
         cross join lateral jsonb_array_elements(coalesce(sp -> 'widgets', '[]'::jsonb)) w
      ) as notes

    from public.boards b
  ) per_board;

  select jsonb_build_object(
    'generated_at',     now(),

    'total_users',      (select count(*) from auth.users),
    'new_24h',          (select count(*) from auth.users where created_at > now() - interval '24 hours'),
    'new_7d',           (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'new_30d',          (select count(*) from auth.users where created_at > now() - interval '30 days'),
    'first_signup_at',  (select min(created_at) from auth.users),
    'last_signup_at',   (select max(created_at) from auth.users),

    'active_24h',       (select count(*) from auth.users where last_sign_in_at > now() - interval '24 hours'),
    'active_7d',        (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'active_30d',       (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
    'never_signed_in',  (select count(*) from auth.users where last_sign_in_at is null),

    'boards',           (select count(*) from public.boards),
    'boards_active_7d', (select count(*) from public.boards where updated_at > now() - interval '7 days'),

    'shape', jsonb_build_object(
      'spaces',        shape.spaces,
      'folders',       shape.folders,
      'bookmarks',     shape.bookmarks,
      'notes',         shape.notes,
      'avg_bookmarks', shape.avg_bookmarks,
      'max_bookmarks', shape.max_bookmarks,
      'empty_boards',  shape.empty_boards
    ),

    'people', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'email',           email,
               'created_at',      created_at,
               'last_sign_in_at', last_sign_in_at
             ) order by created_at desc), '[]'::jsonb)
      from (
        select email, created_at, last_sign_in_at
        from auth.users
        where email is not null
        order by created_at desc
        -- Everyone, not a recent window. The cap is only a runaway guard.
        limit 5000
      ) recent
    ),

    -- Daily signups for the whole life of the project, zero-filled so the chart
    -- has no gaps. Starts at the first signup; falls back to 30 days when there
    -- are none yet, and stops at two years, past which a bar per day is unreadable.
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d, 'signups', c) order by d), '[]'::jsonb)
      from (
        -- `gs`, not `day`: `day` is a keyword in interval syntax and reads
        -- ambiguously as a column alias.
        select gs::date as d, count(u.id) as c
        from generate_series(
               greatest(
                 coalesce((select min(created_at) from auth.users), now() - interval '29 days'),
                 now() - interval '730 days'
               )::date,
               now()::date,
               interval '1 day') as gs
        left join auth.users u on u.created_at::date = gs::date
        group by gs
      ) series
    )
  ) into result;

  return result;
end;
$$;

-- `anon` is the key inside the extension, so every Tabspace user holds it.
-- Take the function away from it entirely; only a signed-in caller may even
-- attempt the call, and the admin table above decides the rest.
revoke all on function public.tabspace_stats() from public, anon;
grant execute on function public.tabspace_stats() to authenticated;


-- ── 4. Board export ────────────────────────────────────────────────────────
--
--  Returns the stored board for one account, or for all of them, in the same
--  shape the extension's own "Export backup" writes -- so a downloaded file can
--  be handed straight back to a user, or re-imported.
--
--  READ THIS BEFORE USING IT. This function returns other people's saved links.
--  The privacy policy shipped with version 1.6.0 tells your users the opposite,
--  in three places: that access "is enforced by row-level security... an account
--  can read and write only its own row", that a board is "a private, per-account
--  row", and that their data is "never sold, rented or shared with anyone".
--  Running this makes two of those statements untrue. Update the policy and
--  republish it before you rely on this, or the published promise and the
--  running code disagree -- which is the part that costs you a store listing.
--
--  Legitimate uses do exist: handing a user their own data back, migrating an
--  account, debugging a corrupted board, answering a data-access request. Those
--  are all one named account at a time, which is why the email argument is
--  required by default and the all-accounts form has to be asked for explicitly.

create or replace function public.tabspace_export(p_email text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  result jsonb;
begin
  if not exists (
    select 1 from public.app_admins where email = coalesce(auth.email(), '')
  ) then
    raise exception 'not authorised';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'email',      u.email,
           'exported_at', now(),
           'rev',        b.rev,
           'updated_at', b.updated_at,
           'state',      b.state
         ) order by b.updated_at desc), '[]'::jsonb)
    into result
  from public.boards b
  join auth.users u on u.id = b.user_id
  where p_email is null or u.email = p_email;

  return result;
end;
$$;

revoke all on function public.tabspace_export(text) from public, anon;
grant execute on function public.tabspace_export(text) to authenticated;


-- ── 5. Tell me who I just made admin ───────────────────────────────────────

select coalesce(
         (select string_agg(email, ', ' order by added_at) from public.app_admins),
         'NO ADMIN SET - no accounts exist yet. Sign up in Tabspace first, then re-run section 2.'
       ) as admin;


-- ───────────────────────────────────────────────────────────────────────────
--  Wrong account, or want a second one? Run either of these on their own.
--
--    insert into public.app_admins (email) values ('you@example.com')
--      on conflict do nothing;
--
--    delete from public.app_admins where email = 'wrong@example.com';
--
--  The dashboard picks the change up on the next Refresh -- the function reads
--  this table on every call, so nothing needs redefining.
-- ───────────────────────────────────────────────────────────────────────────
