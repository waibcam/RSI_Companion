<script lang="ts">
  import { AlertTriangle } from 'lucide-svelte';
  import StatusIncidentHint from './StatusIncidentHint.svelte';

  // Shared error banner used by every module. Previously each module inlined
  // a nearly-identical rose-tinted block with an AlertTriangle and title/msg
  // split — keeping them consistent by hand was getting fiddly. Funnel
  // everything through here so styling + accessibility live in one place.
  //
  // Also renders <StatusIncidentHint/> when the RSI Status feed reports a
  // user-visible incident, so an HTTP error next to "RSI is currently down"
  // is immediately attributable.
  interface Props {
    title: string;
    message: string;
  }
  let { title, message }: Props = $props();
</script>

<div class="flex flex-col gap-2">
  <div
    role="alert"
    class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
  >
    <AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="font-semibold">{title}</p>
      <p class="mt-1 break-all text-rose-300/80">{message}</p>
    </div>
  </div>

  <StatusIncidentHint />
</div>
