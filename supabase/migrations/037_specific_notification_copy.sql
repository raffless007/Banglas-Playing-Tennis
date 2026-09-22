-- Make the built-in payment alerts specific to the session they refer to.
-- The reminder function also adds context at runtime for older/custom rows,
-- but updating the stored defaults keeps the Admin editor truthful as well.
update public.push_alert_schedules
set
  title_template = case code
    when 'payment-30m' then 'Payment due · {date}'
    else 'Payment overdue · {date}'
  end,
  body_template = case code
    when 'payment-30m' then '{date}: ${amount} is due at {location}. PayID {payid}.'
    else '{date}: ${amount} is still outstanding at {location}. PayID {payid}.'
  end,
  updated_at = now()
where code in ('payment-30m', 'payment-12h', 'payment-36h', 'payment-daily');
