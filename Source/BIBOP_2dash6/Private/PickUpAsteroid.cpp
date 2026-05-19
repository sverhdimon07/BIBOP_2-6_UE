// Fill out your copyright notice in the Description page of Project Settings.


#include "PickUpAsteroid.h"

// Sets default values
APickUpAsteroid::APickUpAsteroid()
{
 	// Set this actor to call Tick() every frame.  You can turn this off to improve performance if you don't need it.
	PrimaryActorTick.bCanEverTick = true;

}

// Called when the game starts or when spawned
void APickUpAsteroid::BeginPlay()
{
	Super::BeginPlay();
	
	PickUpMeshComponent->SetSimulatePhysics(true);

}

// Called every frame
void APickUpAsteroid::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);

}
