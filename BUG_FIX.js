// SIGNIN BROKEN

// BROKEN — await inside a non-async function
function doLogin() {
    var res = await fetch(...);   // ← throws at runtime, crashes the IIFE
  }
  
  // CORRECT
  async function doLogin() {
    var res = await fetch(...);   // ← works
  }

  