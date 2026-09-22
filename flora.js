import FLORA from '@flora-ai/flora';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createFlora({ apiKey, workspaceId, projectId }) {
  const client = new FLORA({ apiKey });

  // Cree un projet FLORA dedie (ex. "Test_festif") et renvoie son id.
  async function createProject(name) {
    const p = await client.projects.create({ name, workspace_id: workspaceId });
    return p.project_id;
  }

  // Reserve une URL d'upload, pousse les octets, marque l'upload complet, attend "ready".
  async function uploadImage(buffer, fileName, contentType) {
    const asset = await client.assets.create({
      source: 'signed-url',
      workspace_id: workspaceId,
      file_name: fileName,
      content_type: contentType,
    });

    const up = asset.upload;
    if (!up || !up.url) throw new Error("FLORA n'a pas renvoye d'URL d'upload.");

    const form = new FormData();
    for (const [k, v] of Object.entries(up.form_fields || {})) form.append(k, v);
    form.append(up.file_field || 'file', new Blob([buffer], { type: contentType }), fileName);

    const res = await fetch(up.url, { method: up.method || 'POST', body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Upload FLORA echoue (${res.status}) ${body.slice(0, 200)}`);
    }

    await client.assets.complete(asset.asset_id);

    for (let i = 0; i < 30; i++) {
      const a = await client.assets.retrieve(asset.asset_id);
      if (a.status === 'ready') return a.url;
      if (a.status === 'failed') throw new Error(`Asset en echec : ${a.failure_message || ''}`);
      await sleep(1000);
    }
    throw new Error("L'asset FLORA n'est pas pret a temps.");
  }

  // Lance une generation image-to-image dans le projet donne et renvoie l'URL de sortie.
  // Parametres supplementaires passes tels quels a FLORA, depuis
  // FLORA_EXTRA_PARAMS (JSON). Sert a essayer une resolution ou un ratio sans
  // toucher au code, par exemple {"resolution":"2K"}. Volontairement un
  // passe-plat : inventer un nom de parametre casserait les generations.
  let extra = {};
  if (process.env.FLORA_EXTRA_PARAMS) {
    try {
      extra = JSON.parse(process.env.FLORA_EXTRA_PARAMS);
      console.log('[flora] Parametres supplementaires :', JSON.stringify(extra));
    } catch (e) {
      console.warn('[flora] FLORA_EXTRA_PARAMS illisible (JSON attendu) :', e.message);
    }
  }

  async function edit(assetUrl, { prompt, model, projectId: pid }) {
    const project_id = pid || projectId;
    const gen = await client.generations.create({
      type: 'image',
      prompt,
      model,
      workspace_id: workspaceId,
      project_id,
      params: { image_urls: [assetUrl], ...extra },
    });
    const output = await pollRun(gen.run_id, gen.poll_url, project_id);
    return { url: output.url, cost: gen.charged_cost || 0 };
  }

  async function pollRun(runId, pollUrl, project_id) {
    for (let i = 0; i < 120; i++) {
      let run;
      if (pollUrl) {
        const r = await fetch(pollUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (r.ok) run = await r.json();
      }
      if (!run) {
        for await (const g of client.generations.list({ workspace_id: workspaceId, project_id, limit: 20 })) {
          if (g.run_id === runId) { run = g; break; }
        }
      }
      if (run && run.status === 'completed') {
        const outputs = run.outputs || [];
        const img = outputs.find((o) => o.type === 'imageUrl') || outputs[0];
        if (!img || !img.url) throw new Error('Run termine sans image de sortie.');
        return img;
      }
      if (run && run.status === 'failed') {
        throw new Error(`Generation en echec : ${run.error_message || run.error_code || ''}`);
      }
      await sleep(2500);
    }
    throw new Error('Generation expiree (timeout).');
  }

  // Diagnostic : modeles image accessibles a CETTE cle API.
  async function listModels() {
    const res = await client.models.list({ type: 'image' });
    const models = res.models || res;
    return models.map((m) => ({ model_id: m.model_id, name: m.name, capabilities: m.capabilities }));
  }

  return { createProject, uploadImage, edit, listModels };
}
