-- Model settings: which provider/models run discovery (private.app_config) and the provider
-- API keys (Supabase Vault, encrypted). Every function here is service-role only, so the
-- browser and integration tokens reach them solely through the API's checks.

do $$
begin
  create extension if not exists supabase_vault with schema vault;
exception when others then
  raise notice 'supabase_vault not created here: %', sqlerrm;
end $$;

create or replace function public.set_model_config(p_config jsonb)
returns void language sql security definer set search_path = public, private as $$
  insert into private.app_config (key, value) values ('model_config', p_config::text)
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;

-- Store, replace, or (with a null/blank secret) remove one provider key.
create or replace function public.set_provider_key(p_provider text, p_secret text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare
  v_name text;
  v_id uuid;
begin
  if p_provider not in ('anthropic', 'google', 'typesafe') then
    raise exception 'unknown provider %', p_provider;
  end if;
  v_name := 'reading_app_' || p_provider || '_api_key';
  select id into v_id from vault.secrets where name = v_name;
  if p_secret is null or length(btrim(p_secret)) = 0 then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
    return;
  end if;
  if v_id is null then
    perform vault.create_secret(btrim(p_secret), v_name, 'Reading app model provider API key');
  else
    perform vault.update_secret(v_id, btrim(p_secret));
  end if;
end $$;

-- Saved model config plus decrypted keys, for the edge functions only.
create or replace function public.model_settings_private()
returns jsonb language plpgsql security definer set search_path = public, private, vault as $$
declare
  v_keys jsonb := '{}'::jsonb;
  r record;
begin
  for r in
    select name, decrypted_secret from vault.decrypted_secrets
     where name in ('reading_app_anthropic_api_key', 'reading_app_google_api_key', 'reading_app_typesafe_api_key')
  loop
    v_keys := v_keys || jsonb_build_object(substring(r.name from 'reading_app_(.*)_api_key'), r.decrypted_secret);
  end loop;
  return jsonb_build_object(
    'config', (select value::jsonb from private.app_config where key = 'model_config'),
    'keys', v_keys
  );
end $$;

revoke all on function public.set_model_config(jsonb) from public, anon, authenticated;
revoke all on function public.set_provider_key(text, text) from public, anon, authenticated;
revoke all on function public.model_settings_private() from public, anon, authenticated;
grant execute on function public.set_model_config(jsonb) to service_role;
grant execute on function public.set_provider_key(text, text) to service_role;
grant execute on function public.model_settings_private() to service_role;
