/**
 * ==========================================================================
 * TasteMatch Firebase Configuration & Cloud Firestore Synchronization
 * ==========================================================================
 * Connects web application to Firebase App, Authentication, and Cloud Firestore.
 * Provides real-time synchronization for community recipes, authentication state,
 * and handles offline resilience across devices and accounts.
 */

// Firebase Configuration (TasteMatch production credentials)
var firebaseConfig = {
  apiKey: "AIzaSyBL3Biadtd-vI3gFPaCevZBdiLLnRzG9Ag",
  authDomain: "tastematch-1f149.firebaseapp.com",
  projectId: "tastematch-1f149",
  storageBucket: "tastematch-1f149.firebasestorage.app",
  messagingSenderId: "300453693760",
  appId: "1:300453693760:web:74ecb9f9ebb75d53ef92a5",
  measurementId: "G-NFB1KPE6F3"
};

// Initialize Firebase App
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  try {
    firebase.initializeApp(firebaseConfig);
    console.log('[TasteMatch] Firebase initialized successfully with project:', firebaseConfig.projectId);
  } catch (err) {
    console.error('[TasteMatch] Firebase initialization error:', err);
  }
}

// Global Auth reference
var auth = typeof firebase !== 'undefined' ? firebase.auth() : null;

// Initialize Firebase Cloud Firestore (Persistence disabled: no local disk caching)
var db = null;
if (typeof firebase !== 'undefined' && firebase.firestore) {
  try {
    db = firebase.firestore();
    console.log('[TasteMatch] Cloud Firestore database client initialized (offline disk caching disabled).');
  } catch (err) {
    console.warn('[TasteMatch] Firestore initialization notice:', err);
  }
}
window.db = db;
window.auth = auth;

// Synchronize Firebase auth state with localStorage for backwards compatibility across pages
if (auth) {
  auth.onAuthStateChanged((user) => {
    if (user) {
      const displayName = user.displayName || (user.email ? user.email.split('@')[0] : 'User');
      localStorage.setItem('currentUser', displayName);
      localStorage.setItem('currentUserEmail', user.email || '');
      localStorage.setItem('currentUserId', user.uid);
      console.log('[TasteMatch] Auth state changed: Signed in as', displayName, '(' + user.uid + ')');
    } else {
      localStorage.removeItem('currentUser');
      localStorage.removeItem('currentUserEmail');
      localStorage.removeItem('currentUserId');
      localStorage.removeItem('userRecipes');
      localStorage.removeItem('allCommunityRecipes');

      // Purge any stored recipe comments from local cache
      try {
        Object.keys(localStorage).forEach((k) => {
          if (k.startsWith('comments_') || k.startsWith('savedRecipes_')) {
            localStorage.removeItem(k);
          }
        });
      } catch (e) { }

      console.log('[TasteMatch] Auth state changed: Signed out. Cache purged.');
    }
    // Dispatch custom event for pages that listen
    window.dispatchEvent(new CustomEvent('authStateChanged', { detail: { user } }));
  });
}

// Global in-memory community recipes cache
var _allCommunityRecipes = [];

// Helper to normalize and sanitize recipe records while strictly preserving creator ownership
function normalizeCommunityRecipe(d, docId) {
  // Preserve original creator UID without overwriting with current session
  var creatorUid = d.createdBy || d.userId || d.authorId || '';
  return {
    id: docId || d.id || ('local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
    name: d.name || '',
    category: d.category || 'Appetizers',
    image: d.image || '',
    difficulty: d.difficulty || 'Medium',
    mealType: d.mealType || 'Dish',
    instructions: d.instructions || '',
    createdBy: creatorUid,
    userId: creatorUid,
    authorId: creatorUid,
    authorName: d.authorName || 'Community Chef',
    timestamp: d.timestamp || Date.now()
  };
}

// TasteMatch Community User Recipes Firestore Sync Manager
window.TasteMatchCommunity = {
  // Sync live community recipes from Cloud Firestore
  sync: function (onUpdate) {
    if (!db) {
      console.warn('[TasteMatch] Firestore db not available for community sync.');
      return null;
    }
    try {
      return db.collection('custom_recipes').onSnapshot((snapshot) => {
        const recipes = [];
        snapshot.forEach((doc) => {
          recipes.push(normalizeCommunityRecipe(doc.data(), doc.id));
        });

        _allCommunityRecipes = recipes;

        // Persist shared community recipes in local cache for instant offline rendering
        localStorage.setItem('allCommunityRecipes', JSON.stringify(recipes));
        localStorage.setItem('userRecipes', JSON.stringify(recipes));

        // Notify callback and dispatch global update event
        if (typeof onUpdate === 'function') onUpdate(recipes);
        window.dispatchEvent(new CustomEvent('communityRecipesUpdated', { detail: { recipes } }));
      }, (err) => {
        if (err.message && err.message.includes('has not been used in project') || err.code === 'permission-denied') {
          console.warn('[TasteMatch Firebase Notice] Cloud Firestore database is pending activation in Firebase Console for project ' + firebaseConfig.projectId + '. Visit https://console.firebase.google.com/project/' + firebaseConfig.projectId + '/firestore to create database.');
        } else {
          console.warn('[TasteMatch] Community recipes sync notice:', err.message);
        }
      });
    } catch (e) {
      console.warn('[TasteMatch] Community recipes sync setup note:', e);
      return null;
    }
  },

  // Get all shared community recipes
  getAllRecipes: function () {
    if (_allCommunityRecipes && _allCommunityRecipes.length > 0) {
      return _allCommunityRecipes.slice();
    }
    try {
      const cached = JSON.parse(localStorage.getItem('allCommunityRecipes') || localStorage.getItem('userRecipes')) || [];
      if (Array.isArray(cached) && cached.length > 0) {
        _allCommunityRecipes = cached.map(r => normalizeCommunityRecipe(r, r.id));
        return _allCommunityRecipes.slice();
      }
    } catch (e) {}
    return [];
  },

  // Get shared recipes filtered by category (case-insensitive)
  getRecipesByCategory: function (categoryName) {
    if (!categoryName) return [];
    const target = String(categoryName).trim().toLowerCase();
    return this.getAllRecipes().filter(r => {
      const cat = String(r.category || '').trim().toLowerCase();
      return cat === target;
    });
  },

  // Get personal created recipes filtered strictly by creator UID
  getCreatedRecipes: function (uid) {
    if (!uid) return [];
    const targetUid = String(uid).trim();
    return this.getAllRecipes().filter(r => {
      // Must have an explicit creator UID that matches the authenticated user
      return (r.createdBy && r.createdBy === targetUid) ||
             (r.userId && r.userId === targetUid) ||
             (r.authorId && r.authorId === targetUid);
    });
  },

  // Verify ownership of a recipe
  isOwner: function (recipe, uid) {
    if (!recipe || !uid) return false;
    const targetUid = String(uid).trim();
    return Boolean(
      (recipe.createdBy && recipe.createdBy === targetUid) ||
      (recipe.userId && recipe.userId === targetUid) ||
      (recipe.authorId && recipe.authorId === targetUid)
    );
  },

  // Add a new recipe to Firestore with the creator's authenticated UID
  addRecipe: async function (recipeData) {
    const user = auth ? auth.currentUser : null;
    const currentUid = user ? user.uid : (localStorage.getItem('currentUserId') || '');
    const currentName = user ? (user.displayName || (user.email ? user.email.split('@')[0] : 'Chef')) : (localStorage.getItem('currentUser') || 'Community Chef');

    // Assign authenticated creator UID
    if (currentUid) {
      recipeData.createdBy = currentUid;
      recipeData.userId = currentUid;
      recipeData.authorId = currentUid;
    } else {
      recipeData.createdBy = '';
      recipeData.userId = '';
      recipeData.authorId = '';
    }
    recipeData.authorName = recipeData.authorName || currentName;
    recipeData.timestamp = Date.now();
    recipeData.category = recipeData.category || 'Appetizers';

    // Save to Firebase Cloud Firestore
    if (db) {
      try {
        const firestorePayload = {
          name: recipeData.name || '',
          category: recipeData.category || 'Appetizers',
          image: recipeData.image || '',
          difficulty: recipeData.difficulty || 'Medium',
          mealType: recipeData.mealType || 'Dish',
          instructions: recipeData.instructions || '',
          createdBy: recipeData.createdBy || '',
          userId: recipeData.userId || '',
          authorId: recipeData.authorId || '',
          authorName: recipeData.authorName || 'Community Chef',
          timestamp: recipeData.timestamp,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        const docRef = await db.collection('custom_recipes').add(firestorePayload);
        recipeData.id = docRef.id;
        console.log('[TasteMatch] Custom recipe saved to Firestore successfully! ID:', docRef.id);
      } catch (err) {
        console.warn('[TasteMatch] Firestore custom recipe save notice:', err.message);
        if (!recipeData.id) {
          recipeData.id = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        }
      }
    } else {
      if (!recipeData.id) {
        recipeData.id = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      }
    }

    // Maintain cache and dispatch update
    const all = this.getAllRecipes();
    const existingIdx = all.findIndex(r => r.id === recipeData.id);
    if (existingIdx !== -1) {
      all[existingIdx] = recipeData;
    } else {
      all.unshift(recipeData);
    }
    _allCommunityRecipes = all;
    localStorage.setItem('allCommunityRecipes', JSON.stringify(all));
    localStorage.setItem('userRecipes', JSON.stringify(all));
    window.dispatchEvent(new CustomEvent('communityRecipesUpdated', { detail: { recipes: all } }));
    return recipeData;
  },

  // Edit an existing recipe in Firestore (ownership verified)
  editRecipe: async function (recipeId, recipeData) {
    const user = auth ? auth.currentUser : null;
    const currentUid = user ? user.uid : (localStorage.getItem('currentUserId') || '');

    const all = this.getAllRecipes();
    const existing = all.find(r => r.id === recipeId);

    // Permission check: only the verified creator can edit
    if (existing) {
      const creatorUid = existing.createdBy || existing.userId || existing.authorId;
      if (creatorUid && currentUid && creatorUid !== currentUid) {
        alert('Permission denied: You can only edit recipes that you originally created.');
        return false;
      }
      // Strictly preserve original creator UID
      recipeData.createdBy = existing.createdBy || existing.userId || existing.authorId || '';
      recipeData.userId = existing.userId || existing.createdBy || existing.authorId || '';
      recipeData.authorId = existing.authorId || existing.createdBy || existing.userId || '';
      recipeData.authorName = existing.authorName || 'Community Chef';
      recipeData.timestamp = existing.timestamp || Date.now();
    }

    if (db && recipeId && !recipeId.startsWith('local_')) {
      try {
        await db.collection('custom_recipes').doc(recipeId).update({
          name: recipeData.name,
          category: recipeData.category,
          image: recipeData.image,
          difficulty: recipeData.difficulty,
          mealType: recipeData.mealType,
          instructions: recipeData.instructions,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        console.log('[TasteMatch] Recipe updated in Firestore:', recipeId);
      } catch (err) {
        console.warn('[TasteMatch] Firestore custom recipe update notice:', err.message);
      }
    }

    const idx = all.findIndex(r => r.id === recipeId);
    if (idx !== -1) {
      all[idx] = { ...all[idx], ...recipeData };
      _allCommunityRecipes = all;
      localStorage.setItem('allCommunityRecipes', JSON.stringify(all));
      localStorage.setItem('userRecipes', JSON.stringify(all));
      window.dispatchEvent(new CustomEvent('communityRecipesUpdated', { detail: { recipes: all } }));
    }
    return true;
  },

  // Delete a recipe from Firestore (ownership verified)
  deleteRecipe: async function (recipe, index) {
    const user = auth ? auth.currentUser : null;
    const currentUid = user ? user.uid : (localStorage.getItem('currentUserId') || '');

    if (recipe) {
      const creatorUid = recipe.createdBy || recipe.userId || recipe.authorId;
      if (creatorUid && currentUid && creatorUid !== currentUid) {
        alert('Permission denied: You can only delete recipes that you originally created.');
        return false;
      }
    }

    if (db && recipe && recipe.id && !recipe.id.startsWith('local_')) {
      try {
        await db.collection('custom_recipes').doc(recipe.id).delete();
        console.log('[TasteMatch] Recipe deleted from Firestore:', recipe.id);
      } catch (err) {
        console.warn('[TasteMatch] Firestore custom recipe delete notice:', err.message);
      }
    }

    let all = this.getAllRecipes();
    if (recipe && recipe.id) {
      all = all.filter(r => r.id !== recipe.id);
    } else if (typeof index === 'number') {
      all.splice(index, 1);
    }
    _allCommunityRecipes = all;
    localStorage.setItem('allCommunityRecipes', JSON.stringify(all));
    localStorage.setItem('userRecipes', JSON.stringify(all));
    window.dispatchEvent(new CustomEvent('communityRecipesUpdated', { detail: { recipes: all } }));
    return true;
  }
};

/**
 * Universal Category Page Initializer
 * Mounts recipe loading, creation, editing, deletion, filtering, and favorites
 * for any of the 8 category pages while strictly enforcing category filtering and creator ownership.
 */
window.initCategoryPage = function (categoryName) {
  var recipeGrid = document.getElementById('recipeGrid');
  if (!recipeGrid) return;

  var addRecipeBtn = document.getElementById('addRecipeBtn');
  var addRecipeModal = document.getElementById('addRecipeModal');
  var closeAddModal = document.getElementById('closeAddModal');
  var addRecipeForm = document.getElementById('addRecipeForm');
  var viewRecipeModal = document.getElementById('viewRecipeModal');
  var closeViewModal = document.getElementById('closeViewModal');
  var recipeDetailsEl = document.getElementById('recipeDetails');
  var searchInput = document.getElementById('searchInput');
  var searchButton = document.getElementById('searchButton');
  var profileBtn = document.getElementById('profileBtn');
  var difficultyFilter = document.getElementById('difficultyFilter');
  var mealTypeFilter = document.getElementById('mealTypeFilter');

  var editingRecipe = null;

  function getCurrentUid() {
    if (window.auth && window.auth.currentUser) return window.auth.currentUser.uid;
    return localStorage.getItem('currentUserId') || '';
  }

  function getCurrentUsername() {
    if (window.auth && window.auth.currentUser) {
      var u = window.auth.currentUser;
      return u.displayName || (u.email ? u.email.split('@')[0] : 'User');
    }
    return localStorage.getItem('currentUser') || '';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function isFavorited(title) {
    var user = getCurrentUsername();
    if (!user) return false;
    var savedRecipes = JSON.parse(localStorage.getItem('savedRecipes_' + user)) || [];
    return savedRecipes.some(function (r) { return r.title === title; });
  }

  function toggleFavorite(btn) {
    var user = getCurrentUsername();
    if (!user) {
      window.__navigateTo('signin.html');
      return;
    }
    var title = btn.getAttribute('data-title');
    var desc = btn.getAttribute('data-desc');
    var category = btn.getAttribute('data-category') || categoryName;
    var savedRecipes = JSON.parse(localStorage.getItem('savedRecipes_' + user)) || [];

    var existingIndex = savedRecipes.findIndex(function (r) { return r.title === title; });
    if (existingIndex > -1) {
      savedRecipes.splice(existingIndex, 1);
      btn.textContent = '♡';
      btn.classList.remove('favorited');
    } else {
      savedRecipes.push({ title: title, description: desc, category: category });
      btn.textContent = '♥';
      btn.classList.add('favorited');
    }
    localStorage.setItem('savedRecipes_' + user, JSON.stringify(savedRecipes));
  }

  function createRecipeCard(recipe) {
    var card = document.createElement('div');
    card.className = 'recipe-card user-card';
    var imgSrc = recipe.image && recipe.image.trim() ? recipe.image : 'placeholder.jpg';
    var currentUid = getCurrentUid();
    var isOwner = window.TasteMatchCommunity.isOwner(recipe, currentUid);

    card.innerHTML = `
      <img src="${imgSrc}" alt="${escapeHtml(recipe.name)}" onerror="this.onerror=null; this.src='placeholder.jpg';">
      <div class="card-content">${escapeHtml(recipe.name)}</div>
      <div class="card-info">
        <div><img src="hat.png" alt=""><span>${escapeHtml(recipe.difficulty || '—')}</span></div>
        <div><span>${escapeHtml(recipe.mealType || '—')}</span></div>
      </div>
      <button class="favorite-button" data-title="${escapeHtml(recipe.name)}" data-desc="${escapeHtml(recipe.instructions || 'No description')}" data-category="${escapeHtml(recipe.category || categoryName)}">${isFavorited(recipe.name) ? '♥' : '♡'}</button>
    `;

    // Only creator sees and can trigger Edit / Delete
    if (isOwner) {
      var del = document.createElement('button');
      del.className = 'delete-button';
      del.textContent = 'Delete';
      del.title = 'Delete recipe';
      del.onclick = function (e) {
        e.stopPropagation();
        if (confirm('Are you sure you want to delete this recipe?')) {
          window.TasteMatchCommunity.deleteRecipe(recipe).then(function () {
            reloadUserRecipes();
          });
        }
      };
      card.appendChild(del);

      var edit = document.createElement('button');
      edit.className = 'edit-button';
      edit.textContent = 'Edit';
      edit.title = 'Edit recipe';
      edit.onclick = function (e) {
        e.stopPropagation();
        openEditRecipe(recipe);
      };
      card.appendChild(edit);
    }

    card.onclick = function () {
      showRecipeDetails(recipe);
    };

    var favBtn = card.querySelector('.favorite-button');
    if (favBtn) {
      favBtn.onclick = function (e) {
        e.stopPropagation();
        toggleFavorite(favBtn);
      };
    }

    return card;
  }

  function reloadUserRecipes() {
    var existingUserCards = Array.from(recipeGrid.querySelectorAll('.recipe-card.user-card'));
    existingUserCards.forEach(function (el) { el.remove(); });

    // Retrieve shared recipes filtered strictly by this category
    var categoryRecipes = window.TasteMatchCommunity.getRecipesByCategory(categoryName);

    categoryRecipes.forEach(function (r) {
      var card = createRecipeCard(r);
      recipeGrid.appendChild(card);
    });

    if (searchInput && searchInput.value) {
      filterRecipes(searchInput.value);
    }
  }

  function openEditRecipe(recipe) {
    editingRecipe = recipe;
    var nameEl = document.getElementById('recipeName');
    var imgEl = document.getElementById('recipeImage');
    var instEl = document.getElementById('recipeInstructions');
    var diffEl = document.getElementById('recipeDifficulty');
    var mealEl = document.getElementById('recipeMealType');
    var addTitle = document.getElementById('addTitle');

    if (nameEl) nameEl.value = recipe.name || '';
    if (imgEl) imgEl.value = recipe.image || '';
    if (instEl) instEl.value = recipe.instructions || '';
    if (diffEl) diffEl.value = recipe.difficulty || '';
    if (mealEl) mealEl.value = recipe.mealType || '';
    if (addTitle) addTitle.textContent = 'Edit Your Recipe';

    if (addRecipeModal) {
      addRecipeModal.style.display = 'flex';
      addRecipeModal.setAttribute('aria-hidden', 'false');
    }
  }

  function closeViewRecipeModal() {
    if (viewRecipeModal) {
      viewRecipeModal.style.display = 'none';
      viewRecipeModal.setAttribute('aria-hidden', 'true');
    }
    var cc = document.getElementById('recipe-view-comments-container');
    if (cc && cc.__commentsUnsubscribe) {
      try { cc.__commentsUnsubscribe(); } catch (e) { }
      cc.__commentsUnsubscribe = null;
    }
    if (recipeDetailsEl) recipeDetailsEl.innerHTML = '';
  }

  function showRecipeDetails(recipe) {
    if (!recipe) return;
    var imgSrc = recipe.image && recipe.image.trim() ? recipe.image : 'placeholder.jpg';
    var cat = recipe.category || categoryName || 'Recipe';
    var diff = recipe.difficulty || 'Medium';
    var meal = recipe.mealType || 'Dish';
    var author = recipe.authorName || 'Community Chef';
    var currentUid = getCurrentUid();
    var isOwner = window.TasteMatchCommunity ? window.TasteMatchCommunity.isOwner(recipe, currentUid) : false;

    var diffIcon = diff.toLowerCase() === 'easy' ? '🟢' : (diff.toLowerCase() === 'hard' ? '🔴' : '🟡');
    var mealIcon = meal.toLowerCase().includes('light') ? '🥗' : (meal.toLowerCase().includes('heavy') ? '🍖' : '🍽️');
    var avatarBg = (typeof window.getAvatarBg === 'function') ? window.getAvatarBg(author) : 'linear-gradient(135deg, #00baba, #008f8f)';

    recipeDetailsEl.innerHTML = `
      <div class="recipe-view-card">
        <div class="recipe-view-header">
          <img src="${imgSrc}" alt="${escapeHtml(recipe.name)}" onerror="this.onerror=null; this.src='placeholder.jpg';">
          <div class="recipe-view-header-overlay">
            <div class="recipe-view-badges">
              <span class="recipe-view-badge category">🏷️ ${escapeHtml(cat)}</span>
              <span class="recipe-view-badge difficulty">${diffIcon} ${escapeHtml(diff)}</span>
              <span class="recipe-view-badge meal-type">${mealIcon} ${escapeHtml(meal)}</span>
            </div>
            <h2 class="recipe-view-title">${escapeHtml(recipe.name)}</h2>
          </div>
        </div>

        <div class="recipe-view-body">
          <div class="recipe-view-author-bar">
            <div class="recipe-view-author-info">
              <div class="recipe-view-author-avatar" style="background: ${avatarBg};">
                ${escapeHtml(author.charAt(0).toUpperCase())}
              </div>
              <div>
                <div class="recipe-view-author-name">👨‍🍳 Shared by ${escapeHtml(author)}</div>
                <div class="recipe-view-author-sub">Community Recipe • ${escapeHtml(cat)} Collection</div>
              </div>
            </div>

            <div class="recipe-view-actions">
              <button class="recipe-view-action-btn favorite-btn" id="modal-fav-btn" data-title="${escapeHtml(recipe.name)}" data-category="${escapeHtml(cat)}">
                ${isFavorited(recipe.name) ? '❤️ Favorited' : '🤍 Add to Favorites'}
              </button>
              ${isOwner ? `
                <button class="recipe-view-action-btn edit" id="modal-edit-btn">✏️ Edit</button>
                <button class="recipe-view-action-btn delete" id="modal-delete-btn">🗑️ Delete</button>
              ` : ''}
            </div>
          </div>

          <div class="recipe-view-section">
            <h3 class="recipe-view-section-title">📋 Preparation & Instructions</h3>
            <div class="recipe-view-instructions">${escapeHtml(recipe.instructions || 'No preparation instructions provided.')}</div>
          </div>

          <!-- Reviews & Comments Section -->
          <div class="recipe-view-comments-box">
            <div id="recipe-view-comments-container" class="comments"></div>
          </div>
        </div>
      </div>
    `;

    // Bind Favorite button inside modal
    var favBtn = document.getElementById('modal-fav-btn');
    if (favBtn) {
      favBtn.onclick = function (e) {
        e.stopPropagation();
        toggleFavorite(favBtn);
        favBtn.innerHTML = isFavorited(recipe.name) ? '❤️ Favorited' : '🤍 Add to Favorites';
      };
    }

    // Bind Edit button if owner
    var editBtn = document.getElementById('modal-edit-btn');
    if (editBtn) {
      editBtn.onclick = function (e) {
        e.stopPropagation();
        closeViewRecipeModal();
        openEditRecipe(recipe);
      };
    }

    // Bind Delete button if owner
    var deleteBtn = document.getElementById('modal-delete-btn');
    if (deleteBtn) {
      deleteBtn.onclick = function (e) {
        e.stopPropagation();
        if (confirm('Are you sure you want to delete this recipe?')) {
          window.TasteMatchCommunity.deleteRecipe(recipe).then(function () {
            closeViewRecipeModal();
            reloadUserRecipes();
          });
        }
      };
    }

    if (viewRecipeModal) {
      viewRecipeModal.style.display = 'flex';
      viewRecipeModal.setAttribute('aria-hidden', 'false');
    }

    // Initialize comments for this recipe
    var commentsContainer = document.getElementById('recipe-view-comments-container');
    if (commentsContainer && typeof window.initRecipeComments === 'function') {
      var commentRecipeId = recipe.id || recipe.name || 'custom_recipe';
      window.initRecipeComments(commentsContainer, commentRecipeId);
    }
  }

  window.showRecipeDetailsModal = showRecipeDetails;

  function filterRecipes(query) {
    var q = (query || '').trim().toLowerCase();
    var diffFilter = difficultyFilter ? difficultyFilter.value.trim().toLowerCase() : '';
    var mealFilter = mealTypeFilter ? mealTypeFilter.value.trim().toLowerCase() : '';
    var cards = recipeGrid.querySelectorAll('.recipe-card');

    cards.forEach(function (card) {
      var title = (card.querySelector('.card-content')?.textContent || '').toLowerCase();
      var isUserCard = card.classList.contains('user-card');
      var matches = true;

      if (q && !title.includes(q)) matches = false;

      if (diffFilter) {
        var cardDiff = isUserCard
          ? (card.querySelector('.card-info div:first-child span')?.textContent || '').toLowerCase()
          : (card.getAttribute('data-difficulty') || '').toLowerCase();
        if (!cardDiff.includes(diffFilter)) matches = false;
      }

      if (mealFilter) {
        var cardMeal = isUserCard
          ? (card.querySelector('.card-info div:nth-child(2) span')?.textContent || '').toLowerCase()
          : (card.getAttribute('data-mealtype') || '').toLowerCase();
        if (!cardMeal.includes(mealFilter)) matches = false;
      }

      card.style.display = matches ? 'block' : 'none';
    });
  }

  // Bind static cards favorite buttons
  recipeGrid.querySelectorAll('.favorite-button').forEach(function (btn) {
    var title = btn.getAttribute('data-title');
    if (isFavorited(title)) {
      btn.textContent = '♥';
      btn.classList.add('favorited');
    } else {
      btn.textContent = '♡';
      btn.classList.remove('favorited');
    }
    btn.onclick = function (e) {
      e.stopPropagation();
      toggleFavorite(btn);
    };
  });

  // Bind static recipe-card clicks
  recipeGrid.querySelectorAll('.recipe-card[data-link]').forEach(function (card) {
    var link = card.dataset.link;
    card.onclick = function () { window.__navigateTo(link); };
    card.onkeypress = function (e) { if (e.key === 'Enter') window.__navigateTo(link); };
  });

  if (searchButton && searchInput) {
    searchButton.onclick = function () { filterRecipes(searchInput.value); };
    searchInput.onkeyup = function () { filterRecipes(searchInput.value); };
  }

  if (difficultyFilter) {
    difficultyFilter.onchange = function () { filterRecipes(searchInput ? searchInput.value : ''); };
  }
  if (mealTypeFilter) {
    mealTypeFilter.onchange = function () { filterRecipes(searchInput ? searchInput.value : ''); };
  }

  if (profileBtn) {
    profileBtn.onclick = function () {
      if (localStorage.getItem('currentUser')) {
        window.__navigateTo('profile.html');
      } else {
        window.__navigateTo('signin.html?redirect=' + encodeURIComponent(categoryName + '.html'));
      }
    };
  }

  if (addRecipeBtn) {
    addRecipeBtn.onclick = function () {
      var user = getCurrentUsername();
      if (!user) {
        window.__navigateTo('signin.html?redirect=' + encodeURIComponent(categoryName + '.html'));
        return;
      }
      var addTitle = document.getElementById('addTitle');
      if (addTitle) addTitle.textContent = 'Add Your Recipe';
      editingRecipe = null;
      if (addRecipeForm) addRecipeForm.reset();
      if (addRecipeModal) {
        addRecipeModal.style.display = 'flex';
        addRecipeModal.setAttribute('aria-hidden', 'false');
      }
    };
  }

  if (closeAddModal) {
    closeAddModal.onclick = function () {
      if (addRecipeModal) {
        addRecipeModal.style.display = 'none';
        addRecipeModal.setAttribute('aria-hidden', 'true');
      }
      if (addRecipeForm) addRecipeForm.reset();
      editingRecipe = null;
    };
  }

  if (closeViewModal) {
    closeViewModal.onclick = function () {
      closeViewRecipeModal();
    };
  }

  if (addRecipeForm) {
    addRecipeForm.onsubmit = function (e) {
      e.preventDefault();
      var name = (document.getElementById('recipeName')?.value || '').trim();
      var image = (document.getElementById('recipeImage')?.value || '').trim();
      var instructions = (document.getElementById('recipeInstructions')?.value || '').trim();
      var difficulty = document.getElementById('recipeDifficulty')?.value || 'Medium';
      var mealType = document.getElementById('recipeMealType')?.value || 'Dish';

      if (!name || !instructions) {
        alert('Please provide at least a recipe name and instructions.');
        return;
      }

      if (editingRecipe) {
        var updatedData = {
          name: name,
          category: editingRecipe.category || categoryName,
          image: image,
          difficulty: difficulty,
          mealType: mealType,
          instructions: instructions
        };
        window.TasteMatchCommunity.editRecipe(editingRecipe.id, updatedData).then(function () {
          reloadUserRecipes();
        });
      } else {
        var newRecipe = {
          name: name,
          category: categoryName,
          image: image,
          difficulty: difficulty,
          mealType: mealType,
          instructions: instructions
        };
        window.TasteMatchCommunity.addRecipe(newRecipe).then(function () {
          reloadUserRecipes();
        });
      }

      if (addRecipeModal) {
        addRecipeModal.style.display = 'none';
        addRecipeModal.setAttribute('aria-hidden', 'true');
      }
      addRecipeForm.reset();
      editingRecipe = null;
    };
  }

  window.addEventListener('click', function (e) {
    if (e.target === addRecipeModal) {
      addRecipeModal.style.display = 'none';
      addRecipeModal.setAttribute('aria-hidden', 'true');
      if (addRecipeForm) addRecipeForm.reset();
      editingRecipe = null;
    }
    if (e.target === viewRecipeModal) {
      closeViewRecipeModal();
    }
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (addRecipeModal && addRecipeModal.style.display === 'flex') {
        addRecipeModal.style.display = 'none';
        addRecipeModal.setAttribute('aria-hidden', 'true');
      }
      if (viewRecipeModal && viewRecipeModal.style.display === 'flex') {
        closeViewRecipeModal();
      }
    }
  });

  // Re-render when community recipes or auth state updates
  window.addEventListener('communityRecipesUpdated', reloadUserRecipes);
  window.addEventListener('authStateChanged', reloadUserRecipes);

  // Initial load for this category
  reloadUserRecipes();
};

// Initialize community sync on page load
if (typeof window.TasteMatchCommunity !== 'undefined' && db) {
  window.TasteMatchCommunity.sync();
}
