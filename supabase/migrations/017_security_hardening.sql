-- Trigger helper is internal only; never expose it through PostgREST RPC.
revoke execute on function public.prevent_audit_log_mutation() from anon, authenticated;
