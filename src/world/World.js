module.exports = World;

var Shape = require('../shapes/Shape')
,   Vec3 = require('../math/Vec3')
,   Quaternion = require('../math/Quaternion')
,   GSSolver = require('../solver/GSSolver')
,   Vec3Pool = require('../utils/Vec3Pool')
,   ContactEquation = require('../constraints/ContactEquation')
,   FrictionEquation = require('../constraints/FrictionEquation')
,   ContactGenerator = require('./ContactGenerator')
,   EventTarget = require('../utils/EventTarget')
,   ArrayCollisionMatrix = require('../collision/ArrayCollisionMatrix')
,   Material = require('../material/Material')
,   ContactMaterial = require('../material/ContactMaterial')
,   RigidBody = require('../objects/RigidBody')
,   Body = require('../objects/Body')

/**
 * The physics world
 * @class World
 * @constructor
 * @extends {EventTarget}
 */
function World(){
    EventTarget.apply(this);

    /**
     * Makes bodies go to sleep when they've been inactive
     * @property allowSleep
     * @type {Boolean}
     */
    this.allowSleep = false;

    /**
     * All the current contacts (instances of ContactEquation) in the world.
     * @property contacts
     * @type {Array}
     */
    this.contacts = [];
    this.frictionEquations = [];

    /**
     * How often to normalize quaternions. Set to 0 for every step, 1 for every second etc.. A larger value increases performance. If bodies tend to explode, set to a smaller value (zero to be sure nothing can go wrong).
     * @property quatNormalizeSkip
     * @type {Number}
     */
    this.quatNormalizeSkip = 0;

    /**
     * Set to true to use fast quaternion normalization. It is often enough accurate to use. If bodies tend to explode, set to false.
     * @property quatNormalizeFast
     * @type {Boolean}
     * @see Quaternion.normalizeFast
     * @see Quaternion.normalize
     */
    this.quatNormalizeFast = false;

    /**
     * The wall-clock time since simulation start
     * @property time
     * @type {Number}
     */
    this.time = 0.0;

    /**
     * Number of timesteps taken since start
     * @property stepnumber
     * @type {Number}
     */
    this.stepnumber = 0;

    /// Default and last timestep sizes
    this.default_dt = 1/60;
    this.last_dt = this.default_dt;

    this.nextId = 0;
    /**
     * @property gravity
     * @type {Vec3}
     */
    this.gravity = new Vec3();

    /**
     * @property broadphase
     * @type {Broadphase}
     */
    this.broadphase = null;

    /**
     * @property bodies
     * @type {Array}
     */
    this.bodies = [];

    /**
     * @property solver
     * @type {Solver}
     */
    this.solver = new GSSolver();

    /**
     * @property constraints
     * @type {Array}
     */
    this.constraints = [];

    /**
     * @property contactgen
     * @type {ContactGenerator}
     */
    this.contactgen = new ContactGenerator();

    /**
     * It's actually a triangular-shaped array of whether two bodies are touching this step, for reference next step
     * @property Collision "matrix", size (Nbodies * (Nbodies.length + 1))/2
	 * @type {ArrayCollisionMatrix}
	 */
	this.collisionMatrix = new ArrayCollisionMatrix();

    /**
     * collisionMatrix from the previous step
     * @property Collision "matrix", size (Nbodies * (Nbodies.length + 1))/2
	 * @type {ArrayCollisionMatrix}
	 */
	this.collisionMatrixPrevious = new ArrayCollisionMatrix();

    /**
     * All added materials
     * @property materials
     * @type {Array}
     */
    this.materials = [];

    /**
     * @property contactmaterials
     * @type {Array}
     */
    this.contactmaterials = [];

    this.mats2cmat = []; // Hash: (mat1_id, mat2_id) => contactmat_id

    this.defaultMaterial = new Material("default");

    /**
     * This contact material is used if no suitable contactmaterial is found for a contact.
     * @property defaultContactMaterial
     * @type {ContactMaterial}
     */
    this.defaultContactMaterial = new ContactMaterial(this.defaultMaterial,this.defaultMaterial,0.3,0.0);

    /**
     * @property doProfiling
     * @type {Boolean}
     */
    this.doProfiling = false;

    /**
     * @property profile
     * @type {Object}
     */
    this.profile = {
        solve:0,
        makeContactConstraints:0,
        broadphase:0,
        integrate:0,
        nearphase:0,
    };

    /**
     * @property subystems
     * @type {Array}
     */
    this.subsystems = [];

    this.addBodyEvent = {
        type:"addBody",
        body : null,
    };

    this.removeBodyEvent = {
        type:"removeBody",
        body : null,
    };
};

/**
 * Get the contact material between materials m1 and m2
 * @method getContactMaterial
 * @param {Material} m1
 * @param {Material} m2
 * @return {Contactmaterial} The contact material if it was found.
 */
World.prototype.getContactMaterial = function(m1,m2){
    if((m1 instanceof Material) &&  (m2 instanceof Material)){

        var i = m1.id;
        var j = m2.id;

        if(i<j){
            var temp = i;
            i = j;
            j = temp;
        }
        return this.contactmaterials[this.mats2cmat[i+j*this.materials.length]];
    }
};

/**
 * Get number of objects in the world.
 * @method numObjects
 * @return {Number}
 */
World.prototype.numObjects = function(){
    return this.bodies.length;
};

/**
 * Store old collision state info
 * @method collisionMatrixTick
 */
World.prototype.collisionMatrixTick = function(){
	var temp = this.collisionMatrixPrevious;
	this.collisionMatrixPrevious = this.collisionMatrix;
	this.collisionMatrix = temp;
	this.collisionMatrix.reset();
};

/**
 * Add a rigid body to the simulation.
 * @method add
 * @param {Body} body
 * @todo If the simulation has not yet started, why recrete and copy arrays for each body? Accumulate in dynamic arrays in this case.
 * @todo Adding an array of bodies should be possible. This would save some loops too
 */
World.prototype.add = function(body){
	body.id = this.id();
    body.index = this.bodies.length;
    this.bodies.push(body);
    body.world = this;
    body.position.copy(body.initPosition);
    body.velocity.copy(body.initVelocity);
    body.timeLastSleepy = this.time;
    if(body instanceof RigidBody){
        body.angularVelocity.copy(body.initAngularVelocity);
        body.quaternion.copy(body.initQuaternion);
    }
	this.collisionMatrix.setNumObjects(this.bodies.length);
    this.addBodyEvent.body = body;
    this.dispatchEvent(this.addBodyEvent);
};

/**
 * Add a constraint to the simulation.
 * @method addConstraint
 * @param {Constraint} c
 */
World.prototype.addConstraint = function(c){
    this.constraints.push(c);
    c.id = this.id();
};

/**
 * Removes a constraint
 * @method removeConstraint
 * @param {Constraint} c
 */
World.prototype.removeConstraint = function(c){
    var idx = this.constraints.indexOf(c);
    if(idx!==-1){
        this.constraints.splice(idx,1);
    }
};

/**
 * Generate a new unique integer identifyer
 * @method id
 * @return {Number}
 */
World.prototype.id = function(){
    return this.nextId++;
};

/**
 * Remove a rigid body from the simulation.
 * @method remove
 * @param {Body} body
 */
World.prototype.remove = function(body){
    body.world = null;
    var n = this.numObjects()-1;
    var bodies = this.bodies;
	bodies.splice(body.index, 1);
	for(var i=body.index; i<n;i++) {
		bodies[i].index=i;
	}
	this.collisionMatrix.setNumObjects(n);
    this.removeBodyEvent.body = body;
    this.dispatchEvent(this.removeBodyEvent);
};

/**
 * Adds a material to the World. A material can only be added once, it's added more times then nothing will happen.
 * @method addMaterial
 * @param {Material} m
 */
World.prototype.addMaterial = function(m){
    if(m.id === -1){
        var n = this.materials.length;
        this.materials.push(m);
        m.id = this.materials.length-1;

        // Increase size of materials matrix to (n+1)*(n+1)=n*n+2*n+1 elements, it was n*n last.
        for(var i=0; i!==2*n+1; i++){
            this.mats2cmat.push(-1);
        }
    }
};

/**
 * Adds a contact material to the World
 * @method addContactMaterial
 * @param {ContactMaterial} cmat
 */
World.prototype.addContactMaterial = function(cmat) {

    // Add materials if they aren't already added
    this.addMaterial(cmat.materials[0]);
    this.addMaterial(cmat.materials[1]);

    // Save (material1,material2) -> (contact material) reference for easy access later
    // Make sure i>j, ie upper right matrix
    var i,j;
    if(cmat.materials[0].id > cmat.materials[1].id){
        i = cmat.materials[0].id;
        j = cmat.materials[1].id;
    } else {
        j = cmat.materials[0].id;
        i = cmat.materials[1].id;
    }

    // Add contact material
    this.contactmaterials.push(cmat);
    cmat.id = this.contactmaterials.length-1;

    // Add current contact material to the material table
    this.mats2cmat[i+this.materials.length*j] = cmat.id; // index of the contact material
};

World.prototype._now = function(){
    if(window.performance.webkitNow){
        return window.performance.webkitNow();
    } else {
        return Date.now();
    }
};

/**
 * Step the simulation
 * @method step
 * @param {Number} dt
 */
var World_step_postStepEvent = {type:"postStep"}, // Reusable event objects to save memory
    World_step_preStepEvent = {type:"preStep"},
    World_step_collideEvent = {type:"collide", "with":null, contact:null },
    World_step_oldContacts = [], // Pools for unused objects
    World_step_frictionEquationPool = [],
    World_step_p1 = [], // Reusable arrays for collision pairs
    World_step_p2 = [],
    World_step_gvec = new Vec3(), // Temporary vectors and quats
    World_step_vi = new Vec3(),
    World_step_vj = new Vec3(),
    World_step_wi = new Vec3(),
    World_step_wj = new Vec3(),
    World_step_t1 = new Vec3(),
    World_step_t2 = new Vec3(),
    World_step_rixn = new Vec3(),
    World_step_rjxn = new Vec3(),
    World_step_step_q = new Quaternion(),
    World_step_step_w = new Quaternion(),
    World_step_step_wq = new Quaternion();
World.prototype.step = function(dt){
    var world = this,
        that = this,
        contacts = this.contacts,
        p1 = World_step_p1,
        p2 = World_step_p2,
        N = this.numObjects(),
        bodies = this.bodies,
        solver = this.solver,
        gravity = this.gravity,
        doProfiling = this.doProfiling,
        profile = this.profile,
        DYNAMIC = Body.DYNAMIC,
        now = this._now,
        profilingStart,
        constraints = this.constraints,
        frictionEquationPool = World_step_frictionEquationPool,
        gnorm = gravity.norm(),
        gx = gravity.x,
        gy = gravity.y,
        gz = gravity.z,
        i=0;


    if(doProfiling){
        profilingStart = now();
    }

    if(dt===undefined){
        dt = this.last_dt || this.default_dt;
    }

    // Add gravity to all objects
    for(i=0; i!==N; i++){
        var bi = bodies[i];
        if(bi.motionstate & DYNAMIC){ // Only for dynamic bodies
            var f = bi.force, m = bi.mass;
            f.x += m*gx;
            f.y += m*gy;
            f.z += m*gz;
        }
    }

    // Update subsystems
    for(var i=0, Nsubsystems=this.subsystems.length; i!==Nsubsystems; i++){
        this.subsystems[i].update();
    }

    // 1. Collision detection
    if(doProfiling){ profilingStart = now(); }
    p1.length = 0; // Clean up pair arrays from last step
    p2.length = 0;
    this.broadphase.collisionPairs(this,p1,p2);
    if(doProfiling){ profile.broadphase = now() - profilingStart; }

    this.collisionMatrixTick();

    // Generate contacts
    if(doProfiling){ profilingStart = now(); }
    var oldcontacts = World_step_oldContacts;
    var NoldContacts = contacts.length;

    for(i=0; i!==NoldContacts; i++){
        oldcontacts.push(contacts[i]);
    }
    contacts.length = 0;

    this.contactgen.getContacts(p1,p2,
                                this,
                                contacts,
                                oldcontacts // To be reused
                                );
    if(doProfiling){
        profile.nearphase = now() - profilingStart;
    }

    // Loop over all collisions
    if(doProfiling){
        profilingStart = now();
    }
    var ncontacts = contacts.length;

    // Transfer FrictionEquation from current list to the pool for reuse
    var NoldFrictionEquations = this.frictionEquations.length;
    for(i=0; i!==NoldFrictionEquations; i++){
        frictionEquationPool.push(this.frictionEquations[i]);
    }
    this.frictionEquations.length = 0;

    for(var k=0; k!==ncontacts; k++){

        // Current contact
        var c = contacts[k];

        // Get current collision indeces
        var bi=c.bi, bj=c.bj;

        // Resolve indices
        var i = bodies.indexOf(bi), j = bodies.indexOf(bj);

        // Get collision properties
        var cm = this.getContactMaterial(bi.material,bj.material) || this.defaultContactMaterial;
        var mu = cm.friction;

        // g = ( xj + rj - xi - ri ) .dot ( ni )
        var gvec = World_step_gvec;
        gvec.set(bj.position.x + c.rj.x - bi.position.x - c.ri.x,
                 bj.position.y + c.rj.y - bi.position.y - c.ri.y,
                 bj.position.z + c.rj.z - bi.position.z - c.ri.z);
        var g = gvec.dot(c.ni); // Gap, negative if penetration

        // Action if penetration
        if(g<0.0){
			if (bi.collisionResponse && bj.collisionResponse) {
				c.restitution = cm.restitution;
				c.penetration = g;
				c.stiffness = cm.contactEquationStiffness;
				c.regularizationTime = cm.contactEquationRegularizationTime;

				solver.addEquation(c);

				// Add friction constraint equation
				if(mu > 0){

					// Create 2 tangent equations
					var mug = mu*gnorm;
					var reducedMass = (bi.invMass + bj.invMass);
					if(reducedMass > 0){
						reducedMass = 1/reducedMass;
					}
					var pool = frictionEquationPool;
					var c1 = pool.length ? pool.pop() : new FrictionEquation(bi,bj,mug*reducedMass);
					var c2 = pool.length ? pool.pop() : new FrictionEquation(bi,bj,mug*reducedMass);
					this.frictionEquations.push(c1);
					this.frictionEquations.push(c2);

					c1.bi = c2.bi = bi;
					c1.bj = c2.bj = bj;
					c1.minForce = c2.minForce = -mug*reducedMass;
					c1.maxForce = c2.maxForce = mug*reducedMass;

					// Copy over the relative vectors
					c.ri.copy(c1.ri);
					c.rj.copy(c1.rj);
					c.ri.copy(c2.ri);
					c.rj.copy(c2.rj);

					// Construct tangents
					c.ni.tangents(c1.t,c2.t);

					// Add equations to solver
					solver.addEquation(c1);
					solver.addEquation(c2);
				}
			}

            // Now we know that i and j are in contact. Set collision matrix state
			this.collisionMatrix.set(bi, bj, true);

            if (this.collisionMatrix.get(bi, bj) !== this.collisionMatrixPrevious.get(bi, bj)) {
                // First contact!
                // We reuse the collideEvent object, otherwise we will end up creating new objects for each new contact, even if there's no event listener attached.
                World_step_collideEvent.with = bj;
                World_step_collideEvent.contact = c;
                bi.dispatchEvent(World_step_collideEvent);

                World_step_collideEvent.with = bi;
                bj.dispatchEvent(World_step_collideEvent);

                bi.wakeUp();
                bj.wakeUp();
            }
        }
    }
    if(doProfiling){
        profile.makeContactConstraints = now() - profilingStart;
    }

    if(doProfiling){
        profilingStart = now();
    }

    // Add user-added constraints
    var Nconstraints = constraints.length;
    for(i=0; i!==Nconstraints; i++){
        var c = constraints[i];
        c.update();
        for(var j=0, Neq=c.equations.length; j!==Neq; j++){
            var eq = c.equations[j];
            solver.addEquation(eq);
        }
    }

    // Solve the constrained system
    solver.solve(dt,this);

    if(doProfiling){
        profile.solve = now() - profilingStart;
    }

    // Remove all contacts from solver
    solver.removeAllEquations();

    // Apply damping, see http://code.google.com/p/bullet/issues/detail?id=74 for details
    var pow = Math.pow;
    for(i=0; i!==N; i++){
        var bi = bodies[i];
        if(bi.motionstate & DYNAMIC){ // Only for dynamic bodies
            var ld = pow(1.0 - bi.linearDamping,dt);
            var v = bi.velocity;
            v.mult(ld,v);
            var av = bi.angularVelocity;
            if(av){
                var ad = pow(1.0 - bi.angularDamping,dt);
                av.mult(ad,av);
            }
        }
    }

    this.dispatchEvent(World_step_preStepEvent);

    // Invoke pre-step callbacks
    for(i=0; i!==N; i++){
        var bi = bodies[i];
        if(bi.preStep){
            bi.preStep.call(bi);
        }
    }

    // Leap frog
    // vnew = v + h*f/m
    // xnew = x + h*vnew
    if(doProfiling){
        profilingStart = now();
    }
    var q = World_step_step_q;
    var w = World_step_step_w;
    var wq = World_step_step_wq;
    var stepnumber = this.stepnumber;
    var DYNAMIC_OR_KINEMATIC = Body.DYNAMIC | Body.KINEMATIC;
    var quatNormalize = stepnumber % (this.quatNormalizeSkip+1) === 0;
    var quatNormalizeFast = this.quatNormalizeFast;
    var half_dt = dt * 0.5;
    var PLANE = Shape.types.PLANE,
        CONVEX = Shape.types.CONVEXPOLYHEDRON;

    for(i=0; i!==N; i++){
        var b = bodies[i],
            s = b.shape,
            force = b.force,
            tau = b.tau;
        if((b.motionstate & DYNAMIC_OR_KINEMATIC) && !b.isSleeping()){ // Only for dynamic
            var velo = b.velocity,
                angularVelo = b.angularVelocity,
                pos = b.position,
                quat = b.quaternion,
                invMass = b.invMass,
                invInertia = b.invInertia;
            velo.x += force.x * invMass * dt;
            velo.y += force.y * invMass * dt;
            velo.z += force.z * invMass * dt;

            if(b.angularVelocity){
                angularVelo.x += tau.x * invInertia.x * dt;
                angularVelo.y += tau.y * invInertia.y * dt;
                angularVelo.z += tau.z * invInertia.z * dt;
            }

            // Use new velocity  - leap frog
            pos.x += velo.x * dt;
            pos.y += velo.y * dt;
            pos.z += velo.z * dt;

            if(b.angularVelocity){
                w.set(angularVelo.x, angularVelo.y, angularVelo.z, 0);
                w.mult(quat,wq);
                quat.x += half_dt * wq.x;
                quat.y += half_dt * wq.y;
                quat.z += half_dt * wq.z;
                quat.w += half_dt * wq.w;
                if(quatNormalize){
                    if(quatNormalizeFast){
                        quat.normalizeFast();
                    } else {
                        quat.normalize();
                    }
                }
            }

            if(b.aabbmin){
                b.aabbNeedsUpdate = true;
            }

            if(s){
                switch(s.type){
                case PLANE:
                    s.worldNormalNeedsUpdate = true;
                    break;
                case CONVEX:
                    s.worldFaceNormalsNeedsUpdate = true;
                    s.worldVerticesNeedsUpdate = true;
                    break;
                }
            }
        }
        b.force.set(0,0,0);
        if(b.tau){
            b.tau.set(0,0,0);
        }
    }

    if(doProfiling){
        profile.integrate = now() - profilingStart;
    }

    // Update world time
    this.time += dt;
    this.stepnumber += 1;

    this.dispatchEvent(World_step_postStepEvent);

    // Invoke post-step callbacks
    for(i=0; i!==N; i++){
        var bi = bodies[i];
        var postStep = bi.postStep;
        if(postStep){
            postStep.call(bi);
        }
    }

    // Update world inertias
    // @todo should swap autoUpdate mechanism for .xxxNeedsUpdate
    for(i=0; i!==N; i++){
        var b = bodies[i];
        if(b.inertiaWorldAutoUpdate){
            b.quaternion.vmult(b.inertia,b.inertiaWorld);
        }
        if(b.invInertiaWorldAutoUpdate){
            b.quaternion.vmult(b.invInertia,b.invInertiaWorld);
        }
    }

    // Sleeping update
    if(this.allowSleep){
        for(i=0; i!==N; i++){
            bodies[i].sleepTick(this.time);
        }
    }
};
