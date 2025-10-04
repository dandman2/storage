import { promisify } from 'util';
import { exec as execCb } from 'child_process';

const exec = promisify(execCb);

/** Git commit helper (safe to call when nothing changed) */
export async function commitLogIfChanged(logPath) {
    try {
        await exec('git config user.name "github-actions[bot]"');
        await exec('git config user.email "github-actions[bot]@users.noreply.github.com"');

        await exec(`git add "${logPath}"`);
        try {
            await exec('git diff --cached --quiet');
            return false; // nothing to commit
        } catch { }
        await exec('git commit -m "chore(scanner): update channel log json [skip ci]"');
        try {
            await exec('git push');
        } catch {
            try {
                await exec('git pull --rebase --autostash');
                await exec('git push');
            } catch { }
        }
        console.log('✅ Pushed channel log json changes.');
        return true;
    } catch (e) {
        console.error('git commit/push failed:', e?.message || e);
        return false;
    }
}
