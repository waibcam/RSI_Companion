<script lang="ts">
  import { LogIn } from 'lucide-svelte';
  import { RSI_BASE_URL } from '@rsi-companion/shared';

  interface Props {
    label: string;
  }
  let { label }: Props = $props();
</script>

<div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
  <LogIn class="size-10 text-slate-600" />
  <h2 class="text-base font-semibold text-slate-200">Sign in required</h2>
  <p class="max-w-xs text-xs text-slate-500">
    {label} needs you to be logged in at robertsspaceindustries.com.
  </p>
  <a
    href={`${RSI_BASE_URL}/connect?jumpto=%2F`}
    target="_blank"
    rel="noopener noreferrer"
    class="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-500"
  >
    Open RSI sign-in
  </a>
</div>
