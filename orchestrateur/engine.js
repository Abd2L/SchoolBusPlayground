// Moteur d'orchestration Citémétrie (prototype).
// Logique pure : aucun accès réseau, aucun envoi, aucune écriture hors de l'objet d'état.
(function (root) {
  'use strict';

  const SESSIONS = {
    leo:   { nom: 'Léo',   code: 'LEO', role: 'Emails' },
    sami:  { nom: 'Sami',  code: 'SAM', role: 'Suivi Kotelo' },
    nora:  { nom: 'Nora',  code: 'NOR', role: 'Analyse technique' },
    hugo:  { nom: 'Hugo',  code: 'HUG', role: 'Plans de financement' },
    rania: { nom: 'Rania', code: 'RAN', role: 'ANAH' },
    adam:  { nom: 'Adam',  code: 'ADA', role: 'Aides CD83 / TPM' },
    lina:  { nom: 'Lina',  code: 'LIN', role: 'Prospection' },
  };

  const STATUTS = {
    a_analyser:          { label: 'À analyser',               ton: 'neutre' },
    a_planifier:         { label: 'À planifier',              ton: 'neutre' },
    prete:               { label: 'Prête à transmettre',      ton: 'info' },
    attente_exec:        { label: 'Transmise, en attente',    ton: 'info' },
    en_cours:            { label: 'En cours',                 ton: 'info' },
    bloquee:             { label: 'Bloquée',                  ton: 'warn' },
    a_verifier:          { label: 'Résultat à vérifier',      ton: 'accent' },
    attente_approbation: { label: 'Attend ton approbation',   ton: 'accent' },
    approuvee:           { label: 'Approuvée, à exécuter',    ton: 'info' },
    verifiee:            { label: 'Exécutée et vérifiée',     ton: 'ok' },
    echec:               { label: 'Intervention requise',     ton: 'crit' },
  };

  // Actions sensibles : jamais exécutées sans approbation explicite et ciblée.
  const VALIDATIONS = {
    aucune:     null,
    email:      'Envoi d’un email',
    kotelo:     'Modification dans Kotelo',
    anah:       'Soumission sur le service en ligne ANAH',
    cd83:       'Dépôt de la demande CD83',
    tpm:        'Dépôt de la demande Métropole TPM',
    financier:  'Validation financière',
    documents:  'Déplacement ou écrasement de documents',
  };

  const TERMINAUX = ['verifiee', 'echec'];

  // ---------- état ----------

  function createState(opts) {
    return {
      v: 1,
      seq: 0,
      clock: opts && opts.clock ? opts.clock : null, // horloge fictive pour le jeu de démo et les tests
      dossiers: {},
      tasks: [],
      events: {},   // id d'événement source -> résumé (idempotence)
      threads: {},  // id de conversation -> { emails: [], dossier }
      approvals: [],
      journal: [],
    };
  }

  function now(st) {
    if (st.clock) {
      const d = new Date(st.clock);
      d.setMinutes(d.getMinutes() + 7);
      st.clock = d.toISOString();
      return st.clock;
    }
    return new Date().toISOString();
  }

  function log(st, acteur, nature, message, ref) {
    st.journal.push({ at: now(st), acteur, nature, message, ref: ref || null });
  }

  function addDossier(st, d) {
    st.dossiers[d.id] = Object.assign({ crm: {}, pieces: {} }, d);
    return st.dossiers[d.id];
  }

  function getTask(st, id) {
    const t = st.tasks.find(x => x.id === id);
    if (!t) throw new Error('Tâche introuvable : ' + id);
    return t;
  }

  function findByCle(st, cle) {
    return st.tasks.find(t => t.cle === cle);
  }

  function shortDossier(id) {
    return id.split('-').pop();
  }

  // Crée une tâche, ou renvoie celle qui porte déjà la même clé métier (idempotence).
  function addTask(st, spec) {
    const exist = findByCle(st, spec.cle);
    if (exist) {
      log(st, 'Orchestrateur', 'ignoré', 'Tâche déjà existante pour « ' + spec.titre + ' », rien de recréé', exist.id);
      return { task: exist, created: false };
    }
    st.seq += 1;
    const s = SESSIONS[spec.session];
    const t = {
      id: 'T-' + shortDossier(spec.dossier) + '-' + s.code + '-' + String(st.seq).padStart(3, '0'),
      cle: spec.cle,
      dossier: spec.dossier,
      session: spec.session,
      titre: spec.titre,
      motif: spec.motif,
      source: spec.source || null,
      deps: spec.deps || [],
      priorite: spec.priorite || 2,
      echeance: spec.echeance || null,
      statut: 'a_planifier',
      entrees: spec.entrees || [],
      attendu: spec.attendu || '',
      anomalies: [],
      validation: spec.validation || 'aucune',
      blocage: null,
      resultat: null,
      preuve: null,
      creee: now(st),
      maj: null,
      historique: [],
    };
    t.maj = t.creee;
    st.tasks.push(t);
    histo(st, t, 'Créée : ' + spec.motif);
    log(st, 'Orchestrateur', 'proposition', 'Nouvelle tâche pour ' + s.nom + ' : ' + t.titre, t.id);
    if (spec.blocage) {
      t.statut = 'bloquee';
      t.blocage = spec.blocage;
      histo(st, t, 'Bloquée : ' + spec.blocage);
    }
    refresh(st);
    return { task: t, created: true };
  }

  function histo(st, t, texte) {
    t.maj = now(st);
    t.historique.push({ at: t.maj, texte });
  }

  function depsEnAttente(st, t) {
    return t.deps.filter(id => getTask(st, id).statut !== 'verifiee');
  }

  // Une tâche passe en « Prête » seulement quand toutes ses dépendances sont vérifiées.
  function refresh(st) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of st.tasks) {
        if (t.statut === 'a_planifier' && depsEnAttente(st, t).length === 0) {
          t.statut = 'prete';
          histo(st, t, t.deps.length ? 'Dépendances vérifiées, prête à transmettre' : 'Prête à transmettre');
          changed = true;
        }
      }
    }
  }

  // ---------- transitions ----------

  function exiger(t, statuts, action) {
    if (!statuts.includes(t.statut)) {
      throw new Error('Impossible de « ' + action + ' » ' + t.id + ' : statut actuel « ' + STATUTS[t.statut].label + ' »');
    }
  }

  function transmettre(st, id) {
    const t = getTask(st, id);
    exiger(t, ['prete'], 'transmettre');
    t.statut = 'attente_exec';
    histo(st, t, 'Consigne transmise à ' + SESSIONS[t.session].nom);
    log(st, 'Toi', 'transmission', 'Consigne transmise à ' + SESSIONS[t.session].nom + ' (pas encore réalisée)', id);
    return t;
  }

  function demarrer(st, id) {
    const t = getTask(st, id);
    exiger(t, ['attente_exec'], 'démarrer');
    t.statut = 'en_cours';
    histo(st, t, SESSIONS[t.session].nom + ' a commencé');
    return t;
  }

  function saisirResultat(st, id, texte, anomalie) {
    const t = getTask(st, id);
    exiger(t, ['attente_exec', 'en_cours'], 'enregistrer le résultat de');
    if (!texte || !texte.trim()) throw new Error('Le compte rendu de la session est vide');
    t.resultat = texte.trim();
    if (anomalie && anomalie.trim()) t.anomalies.push(anomalie.trim());
    t.statut = 'a_verifier';
    histo(st, t, 'Compte rendu reçu de ' + SESSIONS[t.session].nom);
    log(st, SESSIONS[t.session].nom, 'résultat', 'Compte rendu déposé' + (anomalie ? ' avec anomalie' : ''), id);
    return t;
  }

  // Vérifie le résultat à partir d'une preuve observable.
  // Action sensible : on s'arrête en « Attend ton approbation ». Sinon : terminée.
  function verifier(st, id, preuve) {
    const t = getTask(st, id);
    exiger(t, ['a_verifier'], 'vérifier');
    if (!preuve || !preuve.trim()) throw new Error('Pas de preuve observable : la tâche ne peut pas être validée');
    t.preuve = preuve.trim();
    if (t.validation !== 'aucune') {
      t.statut = 'attente_approbation';
      histo(st, t, 'Préparation vérifiée, en attente de ton approbation');
      log(st, 'Orchestrateur', 'vérification', 'Préparation vérifiée, approbation requise : ' + VALIDATIONS[t.validation], id);
    } else {
      t.statut = 'verifiee';
      histo(st, t, 'Vérifiée : ' + t.preuve);
      log(st, 'Orchestrateur', 'vérification', 'Résultat vérifié', id);
      apresVerification(st, t);
    }
    refresh(st);
    return t;
  }

  // Une approbation couvre une seule tâche et une seule action.
  function approuver(st, id) {
    const t = getTask(st, id);
    exiger(t, ['attente_approbation'], 'approuver');
    const a = { taskId: id, action: VALIDATIONS[t.validation], resume: t.titre, at: now(st) };
    st.approvals.push(a);
    t.statut = 'approuvee';
    histo(st, t, 'Approuvée par toi : ' + a.action);
    log(st, 'Toi', 'approbation', 'Approuvé : ' + a.action + ' (' + t.titre + ')', id);
    return t;
  }

  function refuser(st, id, motif) {
    const t = getTask(st, id);
    exiger(t, ['attente_approbation'], 'refuser');
    t.statut = 'echec';
    t.anomalies.push('Refusée : ' + (motif || 'sans motif'));
    histo(st, t, 'Refusée par toi');
    log(st, 'Toi', 'refus', 'Refusé : ' + t.titre, id);
    return t;
  }

  // Après approbation, la session exécute. On ne clôt qu'avec la preuve de l'exécution.
  function confirmerExecution(st, id, preuve) {
    const t = getTask(st, id);
    exiger(t, ['approuvee'], 'confirmer l’exécution de');
    if (!preuve || !preuve.trim()) throw new Error('Pas de preuve d’exécution : la tâche reste ouverte');
    t.preuve = preuve.trim();
    t.statut = 'verifiee';
    histo(st, t, 'Exécution constatée : ' + t.preuve);
    log(st, 'Orchestrateur', 'action', 'Exécution vérifiée : ' + t.titre, id);
    apresVerification(st, t);
    refresh(st);
    return t;
  }

  // Compte rendu insuffisant : la tâche retourne à la session, rien n'est clos.
  function renvoyer(st, id, motif) {
    const t = getTask(st, id);
    exiger(t, ['a_verifier'], 'renvoyer');
    t.statut = 'attente_exec';
    t.resultat = null;
    histo(st, t, 'Renvoyée à ' + SESSIONS[t.session].nom + ' : ' + (motif || 'compte rendu insuffisant'));
    log(st, 'Toi', 'renvoi', 'Renvoyée à ' + SESSIONS[t.session].nom + ' : ' + (motif || 'compte rendu insuffisant'), id);
    return t;
  }

  function rouvrir(st, id) {
    const t = getTask(st, id);
    exiger(t, ['echec'], 'rouvrir');
    t.statut = 'a_planifier';
    t.resultat = null;
    t.preuve = null;
    histo(st, t, 'Rouverte par toi');
    log(st, 'Toi', 'réouverture', 'Tâche remise à planifier', id);
    refresh(st);
    return t;
  }

  function bloquer(st, id, cause) {
    const t = getTask(st, id);
    if (TERMINAUX.includes(t.statut)) throw new Error(t.id + ' est déjà close');
    t.avantBlocage = t.statut;
    t.statut = 'bloquee';
    t.blocage = cause || 'Cause non précisée';
    histo(st, t, 'Bloquée : ' + t.blocage);
    log(st, 'Orchestrateur', 'blocage', 'Bloquée : ' + t.blocage, id);
    return t;
  }

  function debloquer(st, id) {
    const t = getTask(st, id);
    exiger(t, ['bloquee'], 'débloquer');
    t.statut = t.avantBlocage && t.avantBlocage !== 'bloquee' ? t.avantBlocage : 'a_planifier';
    t.blocage = null;
    histo(st, t, 'Débloquée');
    log(st, 'Toi', 'déblocage', 'Débloquée', id);
    refresh(st);
    return t;
  }

  // ---------- règles de coordination ----------

  function apresVerification(st, t) {
    const d = st.dossiers[t.dossier];
    // Nora signale une anomalie -> Hugo revoit le plan de financement.
    if (t.session === 'nora' && t.anomalies.length) {
      addTask(st, {
        cle: 'hugo:anomalie:' + t.id,
        dossier: t.dossier, session: 'hugo', priorite: 1,
        titre: 'Revoir le plan de financement suite à l’anomalie de devis',
        motif: 'Anomalie relevée par Nora (' + t.id + ') : ' + t.anomalies[0],
        deps: [t.id],
        entrees: ['Rapport de contrôle ' + t.id, 'Plan de financement en cours'],
        attendu: 'Plan recalculé ou note expliquant pourquoi il reste valable',
        validation: 'financier',
      });
    }
    // Lina : doublon trouvé -> la création est bloquée, à toi de trancher.
    if (t.session === 'lina' && t.cle.indexOf('lina:doublon:') === 0 && t.anomalies.length) {
      const crea = findByCle(st, t.cle.replace('lina:doublon:', 'lina:creation:'));
      if (crea && !TERMINAUX.includes(crea.statut)) bloquer(st, crea.id, 'Doublon possible : ' + t.anomalies[0]);
    }
    // Sami a créé un événement Kotelo : on mémorise son identifiant (lu dans la preuve) pour ne plus en recréer.
    if (t.session === 'sami' && t.source && t.source.thread && !d.crm[t.source.thread]) {
      const m = (t.preuve || '').match(/EVT-\d+/);
      if (m) {
        d.crm[t.source.thread] = m[0];
        log(st, 'Orchestrateur', 'mémorisation', 'Événement Kotelo ' + m[0] + ' rattaché à la conversation, les prochains emails le compléteront', t.id);
      }
    }
  }

  // Point d'entrée unique pour tout ce qui arrive de l'extérieur.
  function ingest(st, ev) {
    if (st.events[ev.id]) {
      log(st, 'Orchestrateur', 'ignoré', 'Événement déjà traité (' + ev.id + '), aucune tâche recréée', null);
      return { doublon: true, crees: [] };
    }
    st.events[ev.id] = { type: ev.type, dossier: ev.dossier, at: now(st), resume: ev.resume || ev.objet || ev.type, payload: ev };
    const avant = st.tasks.length;
    const fn = REGLES[ev.type];
    if (!fn) throw new Error('Type d’événement inconnu : ' + ev.type);
    fn(st, ev);
    const crees = st.tasks.slice(avant).map(t => t.id);
    return { doublon: false, crees };
  }

  const REGLES = {
    // Un email : regroupé par conversation. Une conversation = au plus un événement Kotelo.
    email(st, ev) {
      const d = st.dossiers[ev.dossier];
      const th = st.threads[ev.thread] || (st.threads[ev.thread] = { emails: [], dossier: ev.dossier });
      th.emails.push({ id: ev.id, de: ev.de, objet: ev.objet, at: now(st) });

      const leoOuvert = st.tasks.find(t => t.session === 'leo' && t.source && t.source.thread === ev.thread && !TERMINAUX.includes(t.statut));
      if (leoOuvert) {
        leoOuvert.entrees.push('Email « ' + ev.objet + ' » de ' + ev.de);
        histo(st, leoOuvert, 'Nouvel email regroupé dans la même conversation');
        log(st, 'Orchestrateur', 'regroupement', 'Email ajouté à la conversation déjà suivie, pas de nouvelle tâche', leoOuvert.id);
        // Un brouillon déjà préparé ou approuvé ne tient pas compte de ce message : on le fait refaire.
        if (['a_verifier', 'attente_approbation', 'approuvee'].includes(leoOuvert.statut)) {
          leoOuvert.statut = 'prete';
          leoOuvert.preuve = null;
          leoOuvert.resultat = null;
          histo(st, leoOuvert, 'Brouillon à refaire : nouvel email arrivé après sa préparation');
          log(st, 'Orchestrateur', 'reprise', 'Brouillon périmé, approbation annulée et tâche remise à transmettre', leoOuvert.id);
        }
        return;
      }
      const leo = addTask(st, {
        cle: 'leo:' + ev.thread + ':' + th.emails.length,
        dossier: ev.dossier, session: 'leo', priorite: ev.urgent ? 1 : 2,
        titre: 'Analyser la conversation et préparer la réponse',
        motif: 'Email reçu : « ' + ev.objet + ' »',
        source: { thread: ev.thread },
        entrees: ['Email « ' + ev.objet + ' » de ' + ev.de].concat(ev.pj ? ['Pièces jointes : ' + ev.pj.join(', ')] : []),
        attendu: 'Brouillon de réponse + classement proposé des pièces jointes',
        validation: 'email',
      }).task;

      const evt = d.crm[ev.thread];
      const cleCrm = 'sami:' + ev.thread + (evt ? ':maj:' + ev.id : '');
      const samiExistant = findByCle(st, 'sami:' + ev.thread);
      if (samiExistant && !evt) {
        // Un événement est déjà en préparation pour cette conversation : on l'enrichit au lieu d'en proposer un second.
        if (!TERMINAUX.includes(samiExistant.statut)) {
          samiExistant.entrees.push('Synthèse de Léo (' + leo.id + ')');
          histo(st, samiExistant, 'Nouvel échange de la conversation à intégrer');
        }
        return;
      }
      addTask(st, {
        cle: cleCrm,
        dossier: ev.dossier, session: 'sami', priorite: 2,
        titre: evt ? 'Compléter l’événement Kotelo existant ' + evt : 'Proposer un événement de suivi Kotelo pour la conversation',
        motif: evt ? 'Conversation déjà suivie dans Kotelo (' + evt + '), pas de nouvel événement' : 'Aucun événement Kotelo trouvé pour cette conversation',
        source: { thread: ev.thread },
        deps: [leo.id],
        entrees: ['Synthèse de Léo (' + leo.id + ')', 'Fiche Kotelo du dossier'],
        attendu: evt ? 'Note ajoutée à ' + evt : 'Brouillon d’événement unique regroupant la conversation',
        validation: 'kotelo',
      });
    },

    devis(st, ev) {
      addTask(st, {
        cle: 'nora:devis:' + ev.id,
        dossier: ev.dossier, session: 'nora', priorite: 2,
        titre: 'Contrôler le devis, l’entreprise et son RGE',
        motif: 'Devis reçu : ' + ev.resume,
        entrees: ['Devis ' + ev.resume, 'Certificat RGE de l’entreprise', 'Rapport d’audit énergétique'],
        attendu: 'Rapport de contrôle : conformité technique, RGE valide, cohérence avec l’audit',
        validation: 'aucune',
      });
    },

    accord_anah(st, ev) {
      const rania = addTask(st, {
        cle: 'rania:accord:' + ev.id,
        dossier: ev.dossier, session: 'rania', priorite: 1,
        titre: 'Enregistrer l’accord ANAH et vérifier les montants',
        motif: 'Notification d’accord ANAH (' + ev.montant + ')',
        entrees: ['Courrier d’accord ANAH', 'Plan de financement validé'],
        attendu: 'Montant accordé comparé au plan, écarts signalés',
        validation: 'aucune',
      }).task;
      addTask(st, {
        cle: 'sami:etape:' + ev.id,
        dossier: ev.dossier, session: 'sami', priorite: 2,
        titre: 'Passer le dossier à l’étape « Accordé » dans Kotelo',
        motif: 'Accord ANAH reçu',
        deps: [rania.id],
        entrees: ['Accord vérifié par Rania (' + rania.id + ')'],
        attendu: 'Étape Kotelo mise à jour',
        validation: 'kotelo',
      });
      ['cd83', 'tpm'].forEach(org => addTask(st, {
        cle: 'adam:' + org + ':' + ev.dossier,
        dossier: ev.dossier, session: 'adam', priorite: 2,
        titre: org === 'cd83' ? 'Préparer la demande d’aide du CD83' : 'Préparer la demande Fonds d’aide à l’habitat TPM',
        motif: 'Accord ANAH : les aides complémentaires sont débloquées',
        deps: [rania.id],
        entrees: ['Accord ANAH', 'Plan de financement', 'Pièces du dossier'],
        attendu: org === 'cd83' ? 'Dossier CD83 complet, prêt à déposer' : '9 pièces réunies et plan de financement TPM, prêts à déposer',
        validation: org,
      }));
    },

    demande_pieces(st, ev) {
      const manquantes = ev.pieces.filter(p => !(st.dossiers[ev.dossier].pieces[p]));
      // On n'écrit au propriétaire que pour ce qui manque vraiment.
      if (manquantes.length) {
        addTask(st, {
          cle: 'leo:pieces:' + ev.id,
          dossier: ev.dossier, session: 'leo', priorite: 1, echeance: ev.echeance,
          titre: 'Demander les pièces manquantes au propriétaire',
          motif: 'Demande de pièces ANAH : ' + manquantes.join(', ') + ' à fournir',
          entrees: ['Demande ANAH du ' + ev.date, 'Pièces manquantes : ' + manquantes.join(', ')]
            .concat(manquantes.length < ev.pieces.length ? ['Déjà au dossier, ne pas redemander : ' + ev.pieces.filter(p => !manquantes.includes(p)).join(', ')] : []),
          attendu: 'Brouillon d’email listant les pièces manquantes et la date limite',
          validation: 'email',
        });
      }
      const rassembler = addTask(st, {
        cle: 'rania:pieces:' + ev.id,
        dossier: ev.dossier, session: 'rania', priorite: 1, echeance: ev.echeance,
        titre: 'Rassembler les pièces demandées par l’ANAH',
        motif: 'Demande de pièces ANAH',
        entrees: ev.pieces.map(p => p + (manquantes.includes(p) ? ' (manquante)' : ' (présente)')),
        attendu: 'Toutes les pièces au bon format dans le dossier',
        blocage: manquantes.length ? 'En attente du propriétaire : ' + manquantes.join(', ') : null,
        validation: 'aucune',
      }).task;
      addTask(st, {
        cle: 'rania:reponse:' + ev.id,
        dossier: ev.dossier, session: 'rania', priorite: 1, echeance: ev.echeance,
        titre: 'Répondre à la demande sur le service en ligne ANAH',
        motif: 'Demande de pièces ANAH',
        deps: [rassembler.id],
        entrees: ['Pièces rassemblées (' + rassembler.id + ')'],
        attendu: 'Accusé de dépôt du service en ligne',
        validation: 'anah',
      });
    },

    entretien_prospect(st, ev) {
      const verif = addTask(st, {
        cle: 'lina:doublon:' + ev.dossier,
        dossier: ev.dossier, session: 'lina', priorite: 2,
        titre: 'Chercher un doublon dans Kotelo avant création',
        motif: 'Entretien prospect reçu (' + ev.resume + ')',
        entrees: ['Fiche d’entretien JSON', 'Recherche Kotelo : nom, adresse, téléphone'],
        attendu: 'Résultat de recherche : aucun doublon, ou fiche existante identifiée',
        validation: 'aucune',
      }).task;
      addTask(st, {
        cle: 'lina:creation:' + ev.dossier,
        dossier: ev.dossier, session: 'lina', priorite: 2,
        titre: 'Créer le prospect dans Kotelo',
        motif: 'Entretien prospect reçu',
        deps: [verif.id],
        entrees: ['Fiche d’entretien JSON', 'Résultat de la recherche de doublon'],
        attendu: 'Fiche prospect créée, identifiant Kotelo noté',
        validation: 'kotelo',
      });
    },
  };

  // ---------- consignes ----------

  function consigne(st, id) {
    const t = getTask(st, id);
    const d = st.dossiers[t.dossier];
    const s = SESSIONS[t.session];
    if (t.statut === 'approuvee') {
      const a = st.approvals.filter(x => x.taskId === t.id).pop();
      return [
        'ORDRE D’EXÉCUTION ' + t.id + ' pour ' + s.nom + ' (' + s.role + ')',
        'Dossier : ' + d.id + ' · ' + d.client + ' · ' + d.commune,
        'Approuvé le ' + new Date(a.at).toLocaleString('fr-FR') + ' : ' + VALIDATIONS[t.validation],
        'Action autorisée : ' + t.titre + ', telle que préparée (' + t.preuve + ').',
        'Cette autorisation vaut pour cette seule action. Toute autre action sensible demande une nouvelle approbation.',
        'Compte rendu : complète _orchestration/retours/' + t.id + '.md avec la preuve de l’exécution (ID, n° de dépôt, date d’envoi).',
      ].join('\n');
    }
    const lignes = [
      'CONSIGNE ' + t.id + ' pour ' + s.nom + ' (' + s.role + ')',
      'Dossier : ' + d.id + ' · ' + d.client + ' · ' + d.commune,
      'Tâche : ' + t.titre,
      'Pourquoi : ' + t.motif,
      t.echeance ? 'Échéance : ' + t.echeance : null,
      'Éléments d’entrée :',
    ].concat(t.entrees.map(e => '  - ' + e)).concat([
      'Résultat attendu : ' + t.attendu,
      t.validation !== 'aucune'
        ? 'IMPORTANT : ' + VALIDATIONS[t.validation] + ' soumis à approbation. Prépare seulement, n’exécute rien.'
        : 'Aucune action sensible attendue.',
      'Compte rendu : écris _orchestration/retours/' + t.id + '.md avec statut, résultat, anomalies et preuve (chemin du fichier, ID Kotelo, n° de dépôt).',
      'Si la tâche est déjà faite ou n’a plus lieu d’être, dis-le dans le compte rendu au lieu de la refaire.',
    ]);
    return lignes.filter(Boolean).join('\n');
  }

  // ---------- persistance / reprise ----------

  function serialize(st) { return JSON.stringify(st); }
  function deserialize(txt) {
    const st = JSON.parse(txt);
    if (st.v !== 1) throw new Error('Version d’état inconnue');
    return st;
  }

  // ---------- jeu de démonstration (fictif) ----------

  function demo() {
    const st = createState({ clock: '2026-10-09T06:30:00.000Z' });
    addDossier(st, { id: 'D-2026-0142', client: 'Famille Ferrand', commune: 'Hyères', parcours: 'Rénovation d’ampleur', dpe: ['F', 'C'], etape: 'Instruction ANAH', crm: { 'th-ferrand-rib': 'EVT-8812' }, pieces: { 'RIB': true, 'Avis d’imposition 2025': true } });
    addDossier(st, { id: 'D-2026-0149', client: 'M. Roux', commune: 'Ollioules', parcours: 'Rénovation d’ampleur', dpe: ['E', 'B'], etape: 'Instruction ANAH' });
    addDossier(st, { id: 'D-2026-0157', client: 'Mme Belkacem', commune: 'La Seyne-sur-Mer', parcours: 'Rénovation d’ampleur', dpe: ['G', 'D'], etape: 'Instruction ANAH', pieces: { 'Justificatif de domicile': true } });
    addDossier(st, { id: 'D-2026-0163', client: 'M. Ortiz', commune: 'Toulon', parcours: 'Rénovation d’ampleur', dpe: ['E', 'B'], etape: 'Accordé ANAH' });
    addDossier(st, { id: 'D-2026-0171', client: 'Mme Lambert', commune: 'La Garde', parcours: 'Rénovation d’ampleur', dpe: ['F', 'C'], etape: 'Montage' });
    addDossier(st, { id: 'P-2026-0034', client: 'M. et Mme Nguyen', commune: 'Six-Fours-les-Plages', parcours: 'Prospect', dpe: ['F', null], etape: 'Prospect' });

    // Ferrand : deux emails d'une même conversation, déjà suivie dans Kotelo.
    ingest(st, { id: 'msg-5521', type: 'email', dossier: 'D-2026-0142', thread: 'th-ferrand-rib', de: 'm.ferrand@example.fr', objet: 'Re: RIB et avis d’imposition 2025', pj: ['RIB.pdf', 'avis-2025.pdf'] });
    ingest(st, { id: 'msg-5530', type: 'email', dossier: 'D-2026-0142', thread: 'th-ferrand-rib', de: 'm.ferrand@example.fr', objet: 'Re: Re: RIB et avis d’imposition 2025' });
    const leo = st.tasks.find(t => t.session === 'leo' && t.dossier === 'D-2026-0142');
    transmettre(st, leo.id);
    saisirResultat(st, leo.id, 'Réponse préparée accusant réception des 2 messages. RIB et avis classés dans 0142/Pièces administratives.');
    verifier(st, leo.id, 'Brouillon « Re: RIB et avis… » présent + 2 fichiers dans 0142/Pièces administratives');

    // Lambert : devis avec RGE expiré.
    ingest(st, { id: 'doc-devis-881', type: 'devis', dossier: 'D-2026-0171', resume: 'Soleil Var Rénov, PAC air/eau + isolation combles, 31 420 € TTC' });
    const nora = st.tasks.find(t => t.session === 'nora');
    transmettre(st, nora.id);
    saisirResultat(st, nora.id, 'Devis conforme à l’audit sur les postes. Puissance PAC cohérente (11 kW).', 'Certificat RGE QualiPAC de l’entreprise expiré le 30/09/2026');

    // Belkacem : demande de pièces ANAH, une pièce manque.
    ingest(st, { id: 'anah-dp-3307', type: 'demande_pieces', dossier: 'D-2026-0157', date: '08/10/2026', echeance: '2026-10-24', pieces: ['Attestation de propriété', 'Justificatif de domicile'] });

    // Ortiz : accord ANAH reçu et vérifié, les aides complémentaires se débloquent.
    ingest(st, { id: 'anah-acc-1190', type: 'accord_anah', dossier: 'D-2026-0163', montant: '38 400 €' });
    const rania = st.tasks.find(t => t.cle === 'rania:accord:anah-acc-1190');
    transmettre(st, rania.id);
    saisirResultat(st, rania.id, 'Accord de 38 400 € conforme au plan (écart 0 €).');
    verifier(st, rania.id, 'Courrier d’accord rangé dans 0163/ANAH/accord-2026-10-08.pdf, montant identique au plan v3');
    const samiOrtiz = st.tasks.find(t => t.cle === 'sami:etape:anah-acc-1190');
    transmettre(st, samiOrtiz.id);
    saisirResultat(st, samiOrtiz.id, 'Changement d’étape préparé dans Kotelo, non enregistré.');
    verifier(st, samiOrtiz.id, 'Capture du formulaire Kotelo pré-rempli, étape « Accordé »');

    // Nguyen : entretien prospect.
    ingest(st, { id: 'entretien-0034', type: 'entretien_prospect', dossier: 'P-2026-0034', resume: 'entretien du 08/10, maison 1972, chauffage fioul' });

    st.clock = null; // la suite utilise l'heure réelle
    return st;
  }

  // ---------- tests ----------

  function selfTest() {
    const res = [];
    const test = (nom, fn) => {
      try { const d = fn(); res.push({ nom, ok: true, detail: d || '' }); }
      catch (e) { res.push({ nom, ok: false, detail: e.message }); }
    };
    const assert = (c, m) => { if (!c) throw new Error(m); };
    const base = () => {
      const st = createState({ clock: '2026-10-12T06:00:00.000Z' });
      addDossier(st, { id: 'D-2026-0001', client: 'Test A', commune: 'Toulon', parcours: 'x', dpe: ['F', 'C'], etape: 'x' });
      addDossier(st, { id: 'D-2026-0002', client: 'Test B', commune: 'Hyères', parcours: 'x', dpe: ['F', 'C'], etape: 'x', crm: { 'th-b': 'EVT-1' } });
      return st;
    };
    const mail = (id, th, dos) => ({ id, type: 'email', dossier: dos || 'D-2026-0001', thread: th, de: 'x@example.fr', objet: 'Objet ' + id });

    test('Relancer la même analyse ne crée aucun doublon', () => {
      const st = base();
      ingest(st, mail('m1', 'th-a'));
      const n = st.tasks.length;
      const r = ingest(st, mail('m1', 'th-a'));
      assert(r.doublon && st.tasks.length === n, 'des tâches ont été recréées');
      return n + ' tâches avant et après';
    });
    test('Trois emails d’une conversation donnent une seule tâche Léo et un seul événement CRM', () => {
      const st = base();
      ['m1', 'm2', 'm3'].forEach(m => ingest(st, mail(m, 'th-a')));
      const leo = st.tasks.filter(t => t.session === 'leo');
      const sami = st.tasks.filter(t => t.session === 'sami');
      assert(leo.length === 1 && sami.length === 1, leo.length + ' Léo / ' + sami.length + ' Sami');
      assert(leo[0].entrees.length === 3, 'emails non regroupés');
      return '1 tâche Léo (3 emails), 1 tâche Sami';
    });
    test('Un email arrivé après le brouillon annule l’approbation en attente', () => {
      const st = base();
      ingest(st, mail('m1', 'th-a'));
      const t = st.tasks[0];
      transmettre(st, t.id); saisirResultat(st, t.id, 'brouillon'); verifier(st, t.id, 'brouillon visible');
      ingest(st, mail('m2', 'th-a'));
      assert(t.statut === 'prete' && st.tasks.filter(x => x.session === 'leo').length === 1, t.statut);
      return 'brouillon périmé remis à transmettre, toujours 1 tâche';
    });
    test('Un événement Kotelo existant est complété, pas recréé', () => {
      const st = base();
      ingest(st, mail('m9', 'th-b', 'D-2026-0002'));
      const s = st.tasks.find(t => t.session === 'sami');
      assert(s.titre.indexOf('EVT-1') >= 0, 'nouvel événement proposé');
      return s.titre;
    });
    test('Une tâche transmise n’est pas une tâche réalisée', () => {
      const st = base();
      ingest(st, mail('m1', 'th-a'));
      const t = st.tasks[0];
      transmettre(st, t.id);
      assert(t.statut === 'attente_exec', t.statut);
      return 'statut : ' + STATUTS[t.statut].label;
    });
    test('Pas de clôture sans preuve observable', () => {
      const st = base();
      ingest(st, { id: 'dv', type: 'devis', dossier: 'D-2026-0001', resume: 'x' });
      const t = st.tasks[0];
      transmettre(st, t.id); saisirResultat(st, t.id, 'ok');
      let refuse = false;
      try { verifier(st, t.id, '  '); } catch (e) { refuse = true; }
      assert(refuse && t.statut === 'a_verifier', 'clôturée sans preuve');
      return 'refusé, reste « Résultat à vérifier »';
    });
    test('Une action sensible s’arrête avant exécution', () => {
      const st = base();
      ingest(st, mail('m1', 'th-a'));
      const t = st.tasks[0];
      transmettre(st, t.id); saisirResultat(st, t.id, 'brouillon prêt'); verifier(st, t.id, 'brouillon visible');
      assert(t.statut === 'attente_approbation', t.statut);
      let refuse = false;
      try { confirmerExecution(st, t.id, 'envoyé'); } catch (e) { refuse = true; }
      assert(refuse, 'exécution acceptée sans approbation');
      return 'bloquée en « Attend ton approbation »';
    });
    test('Une approbation ne couvre qu’une seule action', () => {
      const st = base();
      ingest(st, mail('m1', 'th-a'));
      ingest(st, mail('m2', 'th-c'));
      const leos = st.tasks.filter(t => t.session === 'leo');
      leos.forEach(t => { transmettre(st, t.id); saisirResultat(st, t.id, 'ok'); verifier(st, t.id, 'preuve'); });
      approuver(st, leos[0].id);
      assert(leos[1].statut === 'attente_approbation', 'la seconde a été approuvée aussi');
      assert(st.approvals.length === 1 && st.approvals[0].taskId === leos[0].id, 'approbation mal ciblée');
      return '1 approuvée, 1 toujours en attente';
    });
    test('Les aides CD83 et TPM attendent l’accord vérifié', () => {
      const st = base();
      ingest(st, { id: 'acc', type: 'accord_anah', dossier: 'D-2026-0001', montant: '10 €' });
      const adam = st.tasks.filter(t => t.session === 'adam');
      assert(adam.every(t => t.statut === 'a_planifier'), 'Adam démarre trop tôt');
      const r = st.tasks.find(t => t.session === 'rania');
      transmettre(st, r.id); saisirResultat(st, r.id, 'ok'); verifier(st, r.id, 'courrier rangé');
      assert(adam.every(t => t.statut === 'prete'), 'Adam pas débloqué');
      return '2 tâches Adam passées de « À planifier » à « Prête »';
    });
    test('Une pièce manquante ne bloque que l’étape concernée', () => {
      const st = base();
      ingest(st, { id: 'dp', type: 'demande_pieces', dossier: 'D-2026-0001', date: 'x', echeance: '2026-10-24', pieces: ['Attestation'] });
      ingest(st, { id: 'dv', type: 'devis', dossier: 'D-2026-0001', resume: 'x' });
      const ras = st.tasks.find(t => t.cle === 'rania:pieces:dp');
      const rep = st.tasks.find(t => t.cle === 'rania:reponse:dp');
      const leo = st.tasks.find(t => t.cle === 'leo:pieces:dp');
      const nora = st.tasks.find(t => t.session === 'nora');
      assert(ras.statut === 'bloquee' && rep.statut === 'a_planifier', 'blocage mal propagé');
      assert(leo.statut === 'prete' && nora.statut === 'prete', 'blocage trop large');
      return 'réponse ANAH en attente, demande au propriétaire et devis libres';
    });
    test('Une anomalie de devis déclenche Hugo', () => {
      const st = base();
      ingest(st, { id: 'dv', type: 'devis', dossier: 'D-2026-0001', resume: 'x' });
      const n = st.tasks[0];
      transmettre(st, n.id); saisirResultat(st, n.id, 'ok', 'RGE expiré'); verifier(st, n.id, 'rapport');
      const h = st.tasks.find(t => t.session === 'hugo');
      assert(h && h.statut === 'prete' && h.deps[0] === n.id, 'pas de tâche Hugo');
      return h.id + ' créée';
    });
    test('Un doublon prospect bloque la création', () => {
      const st = base();
      ingest(st, { id: 'en', type: 'entretien_prospect', dossier: 'D-2026-0001', resume: 'x' });
      const v = st.tasks.find(t => t.cle.indexOf('lina:doublon') === 0);
      transmettre(st, v.id); saisirResultat(st, v.id, 'recherche faite', 'Fiche « Test A » existe déjà');
      verifier(st, v.id, 'capture de la recherche Kotelo');
      const c = st.tasks.find(t => t.cle.indexOf('lina:creation') === 0);
      assert(c.statut === 'bloquee', c.statut);
      return 'création bloquée, à toi de trancher';
    });
    test('Reprise après interruption sans perte ni doublon', () => {
      const st = base();
      ingest(st, mail('m1', 'th-a'));
      const t = st.tasks[0];
      transmettre(st, t.id); saisirResultat(st, t.id, 'ok'); verifier(st, t.id, 'preuve');
      const st2 = deserialize(serialize(st));
      assert(getTask(st2, t.id).statut === 'attente_approbation', 'approbation perdue');
      const r = ingest(st2, mail('m1', 'th-a'));
      assert(r.doublon && st2.tasks.length === st.tasks.length, 'doublon après reprise');
      approuver(st2, t.id);
      return 'état restauré, approbation reprise au bon endroit';
    });
    test('Un événement Kotelo créé est réutilisé pour la suite de la conversation', () => {
      const st = base();
      ingest(st, mail('m1', 'th-a'));
      const [leo, sami] = st.tasks;
      [leo, sami].forEach(t => {
        transmettre(st, t.id); saisirResultat(st, t.id, 'ok'); verifier(st, t.id, 'préparé');
        approuver(st, t.id); confirmerExecution(st, t.id, t === sami ? 'EVT-4410 créé dans Kotelo' : 'envoyé le 12/10');
      });
      ingest(st, mail('m2', 'th-a'));
      const suite = st.tasks.filter(t => t.session === 'sami');
      assert(suite.length === 2 && suite[1].titre.indexOf('EVT-4410') >= 0, 'nouvel événement proposé');
      return suite[1].titre;
    });
    test('Une transition illégale est refusée', () => {
      const st = base();
      ingest(st, mail('m1', 'th-a'));
      let refuse = false;
      try { approuver(st, st.tasks[0].id); } catch (e) { refuse = true; }
      assert(refuse, 'approbation d’une tâche non prête acceptée');
      return 'refusée';
    });
    return res;
  }

  const E = {
    SESSIONS, STATUTS, VALIDATIONS, TERMINAUX,
    createState, addDossier, addTask, ingest, refresh, getTask, depsEnAttente,
    transmettre, demarrer, saisirResultat, verifier, approuver, refuser, confirmerExecution, renvoyer, rouvrir, bloquer, debloquer,
    consigne, serialize, deserialize, demo, selfTest,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  else root.Orchestrateur = E;
})(this);
